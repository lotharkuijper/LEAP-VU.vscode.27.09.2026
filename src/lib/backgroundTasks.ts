// Achtergrondtaken die doorlopen terwijl je elders in de app werkt.
//
// Een pagina (bv. Beheer → Begrippen) start een taak via startTask(); de taak
// leeft in deze module, BUITEN de React-boom, dus navigeren naar een ander
// deel van de app breekt haar niet af. Het takenvak rechtsonder (TaskTray)
// toont de voortgang en geeft een seintje als de taak klaar is, met een link
// terug naar het resultaat. Komt de docent terug op de pagina, dan leest die
// de lopende taak weer uit (useTask).
//
// Waar de taak draait:
//  * 'server'  — het werk gebeurt op de server (bv. begrippen extraheren); na
//    een herlaadbeurt van de pagina volgt de app de taak gewoon verder
//    (resume via sessionStorage + een geregistreerde "resumer").
//  * 'browser' — de browser doet het werk (bv. bestanden uploaden); dat stopt
//    als het tabblad sluit, dus dan waarschuwt de app eerst.

import { useSyncExternalStore } from 'react';

export type TaskStatus = 'running' | 'done' | 'error';
/** Voortgang: aantal klaar van totaal, met optioneel een vertaalsleutel ({done}/{total} beschikbaar). */
export interface TaskProgress { done: number; total: number; labelKey?: string }

export interface BackgroundTask {
  id: string;
  kind: string;
  /** Bv. de cursus: één lopende taak per (kind, key). */
  key: string;
  title: string;
  status: TaskStatus;
  progress: TaskProgress | null;
  startedAt: number;
  finishedAt?: number;
  summary?: string;
  error?: string;
  result?: unknown;
  resultLink?: string;
  dismissed: boolean;
  where: 'browser' | 'server';
}

export interface TaskContext {
  report: (p: TaskProgress | null) => void;
  /** Voor server-taken: onthoud het taaknummer, zodat we na herladen verder kunnen. */
  setServerJob: (jobId: string) => void;
}

export interface StartOptions<T> {
  kind: string;
  key?: string;
  title: string;
  resultLink?: string;
  where?: 'browser' | 'server';
  /** Mogen meerdere taken van deze soort+sleutel tegelijk lopen (bv. twee upload-reeksen)? */
  parallel?: boolean;
  run: (ctx: TaskContext) => Promise<T>;
  /** Korte samenvatting voor het seintje; een Error-resultaat → foutmelding. */
  summarize?: (result: T) => string | undefined;
}

type Listener = () => void;
let tasks: BackgroundTask[] = [];
const listeners = new Set<Listener>();
const promises = new Map<string, Promise<unknown>>();
const SERVER_KEY = 'leap-server-tasks';

function emit() { for (const l of listeners) l(); }
function patch(id: string, p: Partial<BackgroundTask>) {
  tasks = tasks.map((t) => (t.id === id ? { ...t, ...p } : t));
  emit();
}
let counter = 0;
const newId = () => `task-${Date.now().toString(36)}-${(counter++).toString(36)}`;

// ── Server-taken bewaren voor herladen ──────────────────────────────────────
interface SavedServerTask { id: string; kind: string; key: string; title: string; resultLink?: string; jobId: string; startedAt: number }
function readSaved(): SavedServerTask[] {
  try { return JSON.parse(sessionStorage.getItem(SERVER_KEY) || '[]'); } catch { return []; }
}
function writeSaved(list: SavedServerTask[]) {
  try { sessionStorage.setItem(SERVER_KEY, JSON.stringify(list)); } catch { /* opslag niet beschikbaar */ }
}
function forgetSaved(id: string) { writeSaved(readSaved().filter((s) => s.id !== id)); }

/** Lopende taak van deze soort (en sleutel), of undefined. */
export function findRunning(kind: string, key = ''): BackgroundTask | undefined {
  return tasks.find((t) => t.kind === kind && t.key === key && t.status === 'running');
}

/**
 * Start een achtergrondtaak. Loopt er al een van dezelfde soort voor dezelfde
 * sleutel, dan wordt die teruggegeven (geen dubbele taken).
 */
export function startTask<T>(opts: StartOptions<T>): { id: string; promise: Promise<T> } {
  const key = opts.key ?? '';
  const existing = opts.parallel ? undefined : findRunning(opts.kind, key);
  if (existing) return { id: existing.id, promise: promises.get(existing.id) as Promise<T> };
  const id = newId();
  const task: BackgroundTask = {
    id, kind: opts.kind, key, title: opts.title, status: 'running', progress: null,
    startedAt: Date.now(), resultLink: opts.resultLink, dismissed: false, where: opts.where ?? 'browser',
  };
  tasks = [...tasks, task];
  emit();
  const ctx: TaskContext = {
    report: (p) => patch(id, { progress: p }),
    setServerJob: (jobId) => {
      writeSaved([...readSaved().filter((s) => s.id !== id), { id, kind: task.kind, key, title: task.title, resultLink: task.resultLink, jobId, startedAt: task.startedAt }]);
    },
  };
  const promise = (async () => {
    try {
      const result = await opts.run(ctx);
      const summary = opts.summarize?.(result);
      patch(id, { status: 'done', result, summary, finishedAt: Date.now(), progress: null });
      return result;
    } catch (err) {
      patch(id, { status: 'error', error: err instanceof Error ? err.message : String(err), finishedAt: Date.now(), progress: null });
      throw err;
    } finally {
      forgetSaved(id);
    }
  })();
  promise.catch(() => { /* fout staat in de taak; aanroepers mogen zelf ook afhandelen */ });
  promises.set(id, promise);
  return { id, promise };
}

/** Seintje wegklikken (de taak zelf is dan al klaar). */
export function dismissTask(id: string) { patch(id, { dismissed: true }); }

// ── Hervatten na herladen ───────────────────────────────────────────────────
type Resumer = (jobId: string, ctx: TaskContext) => Promise<unknown>;
const resumers = new Map<string, { resume: Resumer; summarize?: (r: unknown) => string | undefined }>();

/** Registreer hoe een server-taak van deze soort na herladen verder gevolgd wordt. */
export function registerResumer(kind: string, resume: Resumer, summarize?: (r: unknown) => string | undefined) {
  resumers.set(kind, { resume, summarize });
  for (const saved of readSaved().filter((s) => s.kind === kind)) {
    if (tasks.some((t) => t.id === saved.id)) continue;
    const task: BackgroundTask = {
      id: saved.id, kind, key: saved.key, title: saved.title, status: 'running', progress: null,
      startedAt: saved.startedAt, resultLink: saved.resultLink, dismissed: false, where: 'server',
    };
    tasks = [...tasks, task];
    const ctx: TaskContext = { report: (p) => patch(saved.id, { progress: p }), setServerJob: () => {} };
    const promise = resume(saved.jobId, ctx)
      .then((result) => { patch(saved.id, { status: 'done', result, summary: summarize?.(result), finishedAt: Date.now() }); return result; })
      .catch((err) => { patch(saved.id, { status: 'error', error: err instanceof Error ? err.message : String(err), finishedAt: Date.now() }); })
      .finally(() => forgetSaved(saved.id));
    promises.set(saved.id, promise);
  }
  emit();
}

// ── Waarschuwen bij sluiten zolang de browser zelf nog werkt ────────────────
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (tasks.some((t) => t.status === 'running' && t.where === 'browser')) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

// ── React ───────────────────────────────────────────────────────────────────
function subscribe(l: Listener) { listeners.add(l); return () => { listeners.delete(l); }; }
const getSnapshot = () => tasks;

/** Alle taken (voor het takenvak). */
export function useTasks(): BackgroundTask[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Meest recente taak van deze soort en sleutel (lopend of net klaar). */
export function useTask(kind: string, key = ''): BackgroundTask | undefined {
  const all = useTasks();
  for (let i = all.length - 1; i >= 0; i--) if (all[i].kind === kind && all[i].key === key) return all[i];
  return undefined;
}

/** Alleen voor tests. */
export function __resetTasksForTests() { tasks = []; promises.clear(); emit(); try { sessionStorage.removeItem(SERVER_KEY); } catch { /* */ } }
