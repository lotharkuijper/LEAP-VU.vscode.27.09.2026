import { CheckCircle2, XCircle, Loader2, BookOpen, Info, ShieldCheck } from 'lucide-react';
import { useRAGStatus } from '../hooks/useRAGStatus';
import { useLanguage } from '../i18n';

interface RAGStatusIndicatorProps {
  strictMode?: boolean;
}

export function RAGStatusIndicator({ strictMode = false }: RAGStatusIndicatorProps) {
  const { isAvailable, documentCount, chunkCount, loading, noCourse, noRagFolders } = useRAGStatus();
  const { t } = useLanguage();

  const strictBadge = strictMode ? (
    <span
      data-testid="badge-rag-strict-mode"
      title={t('ragStatus.indicator.strictTooltip')}
      className="inline-flex items-center gap-1 px-2 py-1 bg-orange-100 text-orange-700 rounded-md text-xs font-semibold cursor-default select-none"
    >
      <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" />
      {t('ragStatus.indicator.strictLabel')}
    </span>
  ) : null;

  if (loading) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>{t('ragStatus.indicator.loading')}</span>
        </div>
        {strictBadge}
      </div>
    );
  }

  if (noCourse) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 text-gray-500 rounded-lg text-sm">
          <BookOpen className="w-4 h-4 flex-shrink-0" />
          <div className="flex flex-col">
            <span className="font-medium">{t('admin.ragSetup.noActiveCourse')}</span>
            <span className="text-xs text-gray-400">{t('ragStatus.indicator.chooseCourseHint')}</span>
          </div>
        </div>
        {strictBadge}
      </div>
    );
  }

  if (noRagFolders) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 text-gray-500 rounded-lg text-sm">
          <Info className="w-4 h-4 flex-shrink-0" />
          <div className="flex flex-col">
            <span className="font-medium">{t('ragStatus.indicator.noSources')}</span>
            <span className="text-xs text-gray-400">{t('ragStatus.indicator.noSourcesDesc')}</span>
          </div>
        </div>
        {strictBadge}
      </div>
    );
  }

  if (isAvailable) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 px-3 py-2 bg-emerald-100 text-emerald-800 rounded-lg text-sm">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          <div className="flex flex-col">
            <span className="font-medium">{t('ragStatus.indicator.available')}</span>
            <span className="text-xs text-emerald-700">
              {t(documentCount === 1 ? 'ragStatus.indicator.countOne' : 'ragStatus.indicator.countOther', { docs: String(documentCount), chunks: String(chunkCount) })}
            </span>
          </div>
        </div>
        {strictBadge}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex items-center gap-2 px-3 py-2 bg-amber-100 text-amber-800 rounded-lg text-sm">
        <XCircle className="w-4 h-4 flex-shrink-0" />
        <div className="flex flex-col">
          <span className="font-medium">{t('ragStatus.indicator.unavailable')}</span>
          <span className="text-xs text-amber-700">
            {t('ragStatus.indicator.unavailableDesc')}
          </span>
        </div>
      </div>
      {strictBadge}
    </div>
  );
}
