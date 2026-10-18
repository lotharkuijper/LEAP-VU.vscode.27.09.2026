// Regressie Microbiologie (2026-10-18): 534 vensters; één netwerkhapering
// (ECONNRESET) bij venster ~295 brak de hele begrippenextractie af, terwijl
// de andere vensters zinloos doorliepen. Mislukte vensters verdwenen bovendien
// stil (alleen in de serverlog).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mapLimit } from '../conceptConsolidation.js';

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const handler = src.slice(src.indexOf('async function callOpenAI(prompt'), src.indexOf("console.error('[extract-concepts] Unexpected error:'"));

describe('begrippenextractie is bestand tegen haperingen', () => {
  it('callOpenAI vangt netwerkfouten en probeert vaker opnieuw (ook bij 5xx)', () => {
    expect(handler).toMatch(/async function callOpenAI\(prompt, maxRetries = 5\)/);
    expect(handler).toMatch(/catch \(netErr\)/);
    expect(handler).toMatch(/isTransient = resp\.status >= 500/);
  });

  it('een fout in één venster of één verificatie breekt de extractie niet af', () => {
    expect(handler).toMatch(/catch \(winErr\)/);
    expect(handler).toMatch(/catch \(vErr\)/);
  });

  it('mislukte delen en niet-gecontroleerde begrippen staan in de melding aan de docent', () => {
    expect(handler).toMatch(/\$\{failMsg\}\$\{verifyFailMsg\}/);
    expect(handler).toMatch(/failedDocuments: failedDocTitles/);
  });

  it('mapLimit stopt met nieuwe items na een fout', async () => {
    const started = [];
    const run = mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 2, async (n) => {
      started.push(n);
      await new Promise((r) => setTimeout(r, 5));
      if (n === 2) throw new Error('kapot');
      return n;
    });
    await expect(run).rejects.toThrow('kapot');
    await new Promise((r) => setTimeout(r, 30));
    expect(started.length).toBeLessThanOrEqual(3);
  });

  it('mapLimit houdt volgorde en limiet aan', async () => {
    let busy = 0; let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => { busy++; peak = Math.max(peak, busy); await new Promise((r) => setTimeout(r, 2)); busy--; return n * 10; });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });
});
