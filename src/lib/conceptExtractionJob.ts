// Begrippen extraheren als achtergrondtaak (zie POST /api/admin/extract-concepts/jobs).
// De hele cursus lezen duurt minuten; één lang verzoek zou door een proxy
// afgebroken kunnen worden. De server doet het werk; de app start de taak,
// volgt de voortgang via het takenvak (src/lib/backgroundTasks.ts) en loopt
// dus door als de docent naar een ander deel van de app gaat — en na herladen.

import { supabase } from './supabase';
import { startTask, registerResumer, type TaskProgress } from './backgroundTasks';

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
export const CONCEPT_TASK_KIND = 'concepts';

/** Pure: voortgang van de server → voortgang voor het takenvak (met tekstsleutel). */
export function toTaskProgress(p: ExtractionProgress | null | undefined): TaskProgress | null {
  if (!p) return null;
  const labelKey = p.step === 'reading' ? 'admin.conceptJob.reading'
    : p.step === 'merging' ? 'admin.conceptJob.merging' : 'admin.conceptJob.verifying';
  return { done: p.done, total: p.total, labelKey };
}

async function pollJob(jobId: string, token: string, onProgress?: (p: ExtractionProgress) => void, pollMs = POLL_MS): Promise<ExtractionResponse> {
  const headers = { Authorization: `Bearer ${token}` };
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    const r = await fetch(`/api/admin/extract-concepts/jobs/${encodeURIComponent(jobId)}`, { headers });
    const job = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, json: async () => job };
    if (job.progress && onProgress) onProgress(job.progress as ExtractionProgress);
    if (job.status !== 'running') {
      const status = Number(job.httpStatus) || (job.status === 'done' ? 200 : 500);
      return { ok: status < 400, status, json: async () => (job.result || {}) };
    }
  }
}

/** Start de taak op de server en volg haar tot het einde (Response-achtig resultaat). */
export async function runConceptExtraction(
  body: Record<string, unknown>,
  token: string,
  onProgress?: (p: ExtractionProgress) => void,
  pollMs = POLL_MS,
  onJobId?: (jobId: string) => void,
): Promise<ExtractionResponse> {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const start = await fetch('/api/admin/extract-concepts/jobs', { method: 'POST', headers, body: JSON.stringify(body) });
  const started = await start.json().catch(() => ({}));
  if (!start.ok || !started.jobId) {
    return { ok: false, status: start.status || 500, json: async () => started };
  }
  onJobId?.(started.jobId);
  return pollJob(started.jobId, token, onProgress, pollMs);
}

async function resultOrThrow(res: ExtractionResponse): Promise<Record<string, unknown>> {
  const data = await res.json();
  if (!res.ok) throw new Error((data && (data.error as string)) || `HTTP ${res.status}`);
  return data;
}

const summarize = (r: unknown) => (r && typeof r === 'object' && typeof (r as { message?: unknown }).message === 'string'
  ? (r as { message: string }).message : undefined);

/**
 * Begrippen extraheren als achtergrondtaak. `promise` levert het antwoord van
 * de server (zelfde vorm als het oude directe eindpunt) of gooit een fout.
 * Eén lopende taak per cursus: een tweede klik haakt aan bij de eerste.
 */
export function startConceptExtractionTask(opts: {
  courseId: string;
  body: Record<string, unknown>;
  token: string;
  title: string;
  resultLink?: string;
}) {
  return startTask<Record<string, unknown>>({
    kind: CONCEPT_TASK_KIND,
    key: opts.courseId,
    title: opts.title,
    resultLink: opts.resultLink ?? '/admin?tab=concepts',
    where: 'server',
    summarize,
    run: async (ctx) => {
      const res = await runConceptExtraction(opts.body, opts.token, (p) => ctx.report(toTaskProgress(p)), POLL_MS, ctx.setServerJob);
      return resultOrThrow(res);
    },
  });
}

let resumerRegistered = false;
/** Na herladen: lopende extracties van deze sessie weer volgen. Eén keer aanroepen. */
export function registerConceptTaskResumer() {
  if (resumerRegistered) return;
  resumerRegistered = true;
  registerResumer(CONCEPT_TASK_KIND, async (jobId, ctx) => {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await pollJob(jobId, session?.access_token || '', (p) => ctx.report(toTaskProgress(p)));
    return resultOrThrow(res);
  }, summarize);
}
