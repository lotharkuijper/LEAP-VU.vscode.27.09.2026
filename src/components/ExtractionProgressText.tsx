import { Loader2 } from 'lucide-react';
import { useLanguage } from '../i18n';
import { progressLabel, type ExtractionProgress } from '../lib/conceptExtractionJob';

/** Voortgang van de begrippenextractie (lezen → samenvoegen → controleren). */
export function ExtractionProgressText({ progress }: { progress: ExtractionProgress | null }) {
  const { t } = useLanguage();
  const label = progressLabel(progress);
  if (!label || !progress) return null;
  const pct = progress.total > 0 ? Math.round((100 * progress.done) / progress.total) : 0;
  return (
    <div className="mt-2 max-w-md" role="status" aria-live="polite" data-testid="text-extraction-progress">
      <p className="flex items-center gap-1.5 text-xs text-gray-600">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t(label.key as never, label.vars)}
      </p>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-200">
        <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
