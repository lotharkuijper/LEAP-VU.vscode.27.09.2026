import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, AlertTriangle, Loader2, X, ChevronDown, ChevronUp, ArrowRight } from 'lucide-react';
import { useLanguage } from '../i18n';
import { useTasks, dismissTask, type BackgroundTask } from '../lib/backgroundTasks';
import { registerConceptTaskResumer } from '../lib/conceptExtractionJob';
import { Tooltip } from './help/Tooltip';

/** Pure: hoe lang loopt/liep de taak, als "2 min" / "45 s". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
}

function TaskRow({ task, now }: { task: BackgroundTask; now: number }) {
  const { t } = useLanguage();
  const p = task.progress;
  const pct = p && p.total > 0 ? Math.round((100 * p.done) / p.total) : null;
  const vars: Record<string, string> = p ? { done: String(p.done), total: String(p.total) } : {};

  return (
    <li className="rounded-xl bg-white p-3 shadow-lg ring-1 ring-slate-200" data-testid={`task-${task.status}`}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex-shrink-0">
          {task.status === 'running' && <Loader2 className="h-4 w-4 animate-spin text-blue-600" aria-hidden />}
          {task.status === 'done' && <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />}
          {task.status === 'error' && <AlertTriangle className="h-4 w-4 text-red-600" aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900">
            {task.status === 'running' ? task.title
              : task.status === 'done' ? t('tasks.doneTitle', { title: task.title })
              : t('tasks.errorTitle', { title: task.title })}
          </p>
          {task.status === 'running' && (
            <>
              <p className="mt-0.5 text-xs text-slate-600">
                {p?.labelKey ? t(p.labelKey as never, vars) : p ? `${p.done}/${p.total}` : t('tasks.starting')}
                <span className="text-slate-400"> · {formatElapsed(now - task.startedAt)}</span>
              </p>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-200" aria-hidden>
                <div
                  className={`h-full rounded-full bg-blue-500 transition-all ${pct === null ? 'w-1/3 animate-pulse' : ''}`}
                  style={pct === null ? undefined : { width: `${pct}%` }}
                />
              </div>
              <p className="mt-1 text-[11px] text-slate-400">{task.where === 'server' ? t('tasks.keepsRunning') : t('tasks.keepTabOpen')}</p>
            </>
          )}
          {task.status === 'done' && task.summary && <p className="mt-0.5 line-clamp-3 text-xs text-slate-600">{task.summary}</p>}
          {task.status === 'error' && task.error && <p className="mt-0.5 line-clamp-3 text-xs text-red-700">{task.error}</p>}
          {task.status !== 'running' && task.resultLink && (
            <Link
              to={task.resultLink}
              onClick={() => dismissTask(task.id)}
              className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline"
              data-testid="link-task-result"
            >
              {t('tasks.viewResult')}<ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          )}
        </div>
        {task.status !== 'running' && (
          <Tooltip label={t('common.close')}>
            <button type="button" onClick={() => dismissTask(task.id)} className="flex-shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" data-testid="button-dismiss-task">
              <X className="h-4 w-4" />
            </button>
          </Tooltip>
        )}
      </div>
    </li>
  );
}

/**
 * Takenvak rechtsonder: lopende achtergrondtaken met voortgang, en een seintje
 * als een taak klaar is ("… is klaar — Bekijk resultaat"). Staat buiten de
 * pagina's, dus blijft zichtbaar als je naar een ander deel van de app gaat.
 */
export function TaskTray() {
  const { t } = useLanguage();
  const tasks = useTasks().filter((task) => !task.dismissed);
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const running = tasks.filter((task) => task.status === 'running').length;

  useEffect(() => { registerConceptTaskResumer(); }, []);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  // Nieuw seintje (taak klaar) → vak weer openklappen.
  const finishedCount = tasks.length - running;
  useEffect(() => { if (finishedCount > 0) setCollapsed(false); }, [finishedCount]);

  if (tasks.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[90] w-[min(22rem,calc(100vw-2rem))]"
      role="region"
      aria-label={t('tasks.regionLabel')}
      data-testid="task-tray"
    >
      <div aria-live="polite" className="sr-only">
        {tasks.filter((task) => task.status !== 'running').map((task) => (task.status === 'done' ? t('tasks.doneTitle', { title: task.title }) : t('tasks.errorTitle', { title: task.title }))).join('. ')}
      </div>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="mb-2 ml-auto flex items-center gap-1.5 rounded-full bg-slate-900/85 px-3 py-1 text-xs font-medium text-white shadow hover:bg-slate-900"
        data-testid="button-toggle-task-tray"
      >
        {running > 0 && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
        {running > 0 ? t('tasks.runningCount', { n: String(running) }) : t('tasks.finishedCount', { n: String(tasks.length) })}
        {collapsed ? <ChevronUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
      </button>
      {!collapsed && (
        <ul className="max-h-[60vh] space-y-2 overflow-y-auto">
          {tasks.slice(-4).map((task) => <TaskRow key={task.id} task={task} now={now} />)}
        </ul>
      )}
    </div>
  );
}
