// Regressie: 157 bestanden tegelijk geüpload → 157 verwerkingen tegelijk →
// Azure-snelheidslimiet → 63 "inlezen mislukt" (Microbiologie, 2026-10-16).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createProcessingQueue } from '../processingQueue.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 20) { for (let i = 0; i < n; i++) await tick(); }

/** Nep-embeddingsdienst: weigert (429) zodra er meer dan `limit` tegelijk lopen. */
function fakeService(limit) {
  let busy = 0; let peak = 0;
  const done = [];
  return {
    get peak() { return peak; },
    done,
    async run(id) {
      busy += 1; peak = Math.max(peak, busy);
      await Promise.resolve(); await Promise.resolve();
      const over = busy > limit;
      busy -= 1;
      if (over) { const e = new Error('rate'); e.isRateLimit = true; throw e; }
      done.push(id);
    },
  };
}

describe('wachtrij voor het inlezen', () => {
  it('157 uploads: nooit meer dan `concurrency` tegelijk, en alles wordt ingelezen', async () => {
    const svc = fakeService(3);
    const failed = [];
    const q = createProcessingQueue({ run: (id) => svc.run(id), concurrency: 2, isRetryable: (e) => e.isRateLimit, onGiveUp: (id) => failed.push(id), setTimer: (f) => setTimeout(f, 0) });
    for (let i = 0; i < 157; i++) q.enqueue(`doc-${i}`);
    for (let i = 0; i < 5000 && q.stats().known > 0; i++) await tick();
    expect(svc.peak).toBeLessThanOrEqual(2);
    expect(failed).toEqual([]);
    expect(svc.done).toHaveLength(157);
    expect(q.stats()).toEqual({ waiting: 0, active: 0, known: 0 });
  });

  it('snelheidslimiet: opnieuw in de rij met een pauze, pas na het maximum "mislukt"', async () => {
    const timers = [];
    const retries = [];
    const gaveUp = [];
    let calls = 0;
    const q = createProcessingQueue({
      run: async () => { calls += 1; const e = new Error('429'); e.isRateLimit = true; throw e; },
      maxAttempts: 3, backoffMs: (a) => a * 1000, isRetryable: (e) => e.isRateLimit,
      onRetry: (id, _e, attempt) => retries.push(attempt), onGiveUp: (id) => gaveUp.push(id),
      setTimer: (f, ms) => { timers.push(ms); f(); },
    });
    q.enqueue('a');
    await settle();
    expect(calls).toBe(3);
    expect(retries).toEqual([2, 3]);
    expect(timers).toEqual([2000, 3000]);
    expect(gaveUp).toEqual(['a']);
  });

  it('een gewone fout is meteen definitief, en een document staat er maar één keer in', async () => {
    const gaveUp = [];
    let calls = 0;
    const q = createProcessingQueue({ run: async () => { calls += 1; throw new Error('kapot bestand'); }, isRetryable: (e) => !!e.isRateLimit, onGiveUp: (id) => gaveUp.push(id) });
    expect(q.enqueue('x')).toBe(true);
    expect(q.enqueue('x')).toBe(false);
    await settle();
    expect(calls).toBe(1);
    expect(gaveUp).toEqual(['x']);
    expect(q.enqueue('x')).toBe(true); // daarna mag hij weer (opnieuw inlezen)
  });

  it('uploads en "opnieuw inlezen" lopen via de wachtrij, niet los', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'courseFiles.js'), 'utf8');
    const start = src.slice(src.indexOf('function startProcessing'), src.indexOf('async function loadDoc'));
    expect(start).toMatch(/processingQueue\.enqueue\(/);
    expect(start).not.toMatch(/processRagDocumentById\(/);
    expect(src).toMatch(/\/reprocess'/);
  });
});
