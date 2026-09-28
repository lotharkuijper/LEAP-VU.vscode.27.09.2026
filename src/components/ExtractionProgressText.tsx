import { Loader2 } from 'lucide-react';
import { useLanguage } from '../i18n';
import type { TaskProgress } from '../lib/backgroundTasks';

/** Voortgang van een taak bij de knop die haar startte (lezen → samenvoegen → controleren). */
export function ExtractionProgressText({ progress }: { progress: TaskProgress | null | undefined }) {
  const { t } = useLanguage();
  if (!progress) return null;
  const pct = progress.total > 0 ? Math.round((100 * progress.done) / progress.total) : 0;
  const vars = { done: String(progress.done), total: String(progress.total) };
  return (
    <div className="mt-2 max-w-md" role="status" aria-live="polite" data-testid="text-extraction-progress">
      <p className="flex items-center gap-1.5 text-xs text-gray-600">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {progress.labelKey ? t(progress.labelKey as never, vars) : `${progress.done}/${progress.total}`}
      </p>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-200">
        <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
