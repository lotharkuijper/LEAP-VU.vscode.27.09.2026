import { useLanguage } from '../i18n';

interface RAGDiagnosticsProps {
  matchCount: number;
  threshold: number;
  maxSimilarity: number;
  candidatesConsidered?: number;
  searchPerformed?: boolean;
  className?: string;
  viewerRole?: string | null;
}

export function RAGDiagnostics({
  matchCount,
  threshold,
  maxSimilarity,
  candidatesConsidered,
  searchPerformed = true,
  className = '',
  viewerRole,
}: RAGDiagnosticsProps) {
  const { t } = useLanguage();
  if (viewerRole === 'student') {
    return null;
  }

  const formatScore = (n: number) => n.toFixed(2);

  if (!searchPerformed) {
    return (
      <div
        className={`text-xs text-gray-500 italic ${className}`}
        data-testid="rag-diagnostics"
      >
        {t('ragDiagnostics.noSearch')}
      </div>
    );
  }

  if (matchCount === 0) {
    if (!candidatesConsidered || candidatesConsidered === 0) {
      return (
        <div
          className={`text-xs text-gray-500 italic ${className}`}
          data-testid="rag-diagnostics"
        >
          {t('ragDiagnostics.noCandidates', { threshold: formatScore(threshold) })}
        </div>
      );
    }

    return (
      <div
        className={`text-xs text-gray-500 italic ${className}`}
        data-testid="rag-diagnostics"
      >
        {t('ragDiagnostics.noneAboveThreshold', { threshold: formatScore(threshold) })}
        {' '}— {t('ragDiagnostics.bestMatch')}{' '}
        <span className="font-mono">{formatScore(maxSimilarity)}</span>
        {' '}{t('ragDiagnostics.candidatesConsidered', { n: String(candidatesConsidered) })}
      </div>
    );
  }

  return (
    <div
      className={`text-xs text-gray-500 italic ${className}`}
      data-testid="rag-diagnostics"
    >
      {t('ragDiagnostics.basedOn')}{' '}
      <span className="font-medium">{matchCount}</span>{' '}
      {t(matchCount !== 1 ? 'ragDiagnostics.passagesOther' : 'ragDiagnostics.passagesOne')}
      {' '}• {t('ragDiagnostics.highestMatch')}{' '}
      <span className="font-mono">{formatScore(maxSimilarity)}</span>
      {' '}• {t('ragDiagnostics.threshold')}{' '}
      <span className="font-mono">{formatScore(threshold)}</span>
    </div>
  );
}
