import { describe, it, expect, vi, afterEach } from 'vitest';
import { runConceptExtraction, toTaskProgress } from '../conceptExtractionJob';

afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

describe('runConceptExtraction — als achtergrondtaak', () => {
  it('start de taak, meldt voortgang en geeft het eindresultaat terug zoals het oude eindpunt', async () => {
    const replies = [
      json(202, { jobId: 'j1' }),
      json(200, { status: 'running', progress: { step: 'reading', done: 3, total: 30 } }),
      json(200, { status: 'running', progress: { step: 'verifying', done: 50, total: 120 } }),
      json(200, { status: 'done', httpStatus: 200, result: { message: '100 begrippen', concepts: [{ name: 'betrouwbaarheidsinterval' }] } }),
    ];
    const fetchMock = vi.fn(async (_url: string, _init?: unknown) => replies.shift());
    vi.stubGlobal('fetch', fetchMock);
    const seen: string[] = [];
    const res = await runConceptExtraction({ courseId: 'c1' }, 'tok', (p) => seen.push(`${p.step}:${p.done}/${p.total}`), 0);
    expect(res.ok).toBe(true);
    expect(await res.json()).toMatchObject({ message: '100 begrippen' });
    expect(seen).toEqual(['reading:3/30', 'verifying:50/120']);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/extract-concepts/jobs');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/admin/extract-concepts/jobs/j1');
  });

  it('een fout van de taak komt terug met de oorspronkelijke status en melding', async () => {
    const replies = [
      json(202, { jobId: 'j2' }),
      json(200, { status: 'error', httpStatus: 503, result: { error: 'token-limiet' } }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => replies.shift()));
    const res = await runConceptExtraction({ courseId: 'c1' }, 'tok', undefined, 0);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'token-limiet' });
  });

  it('kan de taak niet starten → meteen een fout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(403, { error: 'Geen toegang' })));
    const res = await runConceptExtraction({ courseId: 'c1' }, 'tok', undefined, 0);
    expect(res.status).toBe(403);
  });
});

describe('toTaskProgress', () => {
  it('zet de stap om in een vertaalsleutel voor het takenvak', () => {
    expect(toTaskProgress({ step: 'reading', done: 2, total: 9 })).toEqual({ done: 2, total: 9, labelKey: 'admin.conceptJob.reading' });
    expect(toTaskProgress({ step: 'verifying', done: 1, total: 3 })?.labelKey).toBe('admin.conceptJob.verifying');
    expect(toTaskProgress(null)).toBeNull();
  });
});
