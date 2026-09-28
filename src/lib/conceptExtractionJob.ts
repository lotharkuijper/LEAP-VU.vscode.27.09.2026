// Begrippen extraheren als achtergrondtaak (zie POST /api/admin/extract-concepts/jobs).
// De hele cursus lezen duurt minuten; één lang verzoek zou door een proxy
// afgebroken kunnen worden. Deze hulp start de taak, vraagt de voortgang op en
// geeft daarna een Response-achtig object terug met hetzelfde antwoord als het
// oude, directe eindpunt — zodat aanroepers niets anders hoeven te doen.

export interface ExtractionProgress {
  step: 'reading' | 'merging' | 'verifying';
  done: number;
  total: number;
}

export interface ExtractionResponse {
  ok: boolean;
  status: number;
  // Zelfde (losse) typering als fetch().json(), zodat bestaande aanroepers ongewijzigd blijven.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: () => Promise<any>;
}

const POLL_MS = 2500;

export async function runConceptExtraction(
  body: Record<string, unknown>,
  token: string,
  onProgress?: (p: ExtractionProgress) => void,
  pollMs = POLL_MS,
): Promise<ExtractionResponse> {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const start = await fetch('/api/admin/extract-concepts/jobs', { method: 'POST', headers, body: JSON.stringify(body) });
  const started = await start.json().catch(() => ({}));
  if (!start.ok || !started.jobId) {
    return { ok: false, status: start.status || 500, json: async () => started };
  }
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    const r = await fetch(`/api/admin/extract-concepts/jobs/${encodeURIComponent(started.jobId)}`, { headers });
    const job = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, json: async () => job };
    if (job.progress && onProgress) onProgress(job.progress as ExtractionProgress);
    if (job.status !== 'running') {
      const status = Number(job.httpStatus) || (job.status === 'done' ? 200 : 500);
      return { ok: status < 400, status, json: async () => (job.result || {}) };
    }
  }
}

/** Pure: voortgang als korte zin-sleutel + waarden voor de UI. */
export function progressLabel(p: ExtractionProgress | null): { key: string; vars: Record<string, string> } | null {
  if (!p) return null;
  const vars = { done: String(p.done), total: String(p.total) };
  if (p.step === 'reading') return { key: 'admin.conceptJob.reading', vars };
  if (p.step === 'merging') return { key: 'admin.conceptJob.merging', vars };
  return { key: 'admin.conceptJob.verifying', vars };
}
