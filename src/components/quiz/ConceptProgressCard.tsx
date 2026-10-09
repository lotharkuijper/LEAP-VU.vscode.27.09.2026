// "Jouw voortgang" op de quizpagina: wat je per begrip beheerst en wat je nu
// het best kunt oefenen (src/lib/conceptProgress.ts). Alleen voor jezelf.
import { useMemo, useState } from 'react';
import { Target, Sparkles } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { HelpTip } from '../help/HelpTip';
import { buildConceptProgress, pickPracticeSet, type ProgressAttempt, type ProgressTopic, type ConceptProgress } from '../../lib/conceptProgress';

const REASON_STYLE: Record<ConceptProgress['reason'], string> = {
  weak: 'bg-red-50 text-red-700 border-red-200',
  due: 'bg-amber-50 text-amber-700 border-amber-200',
  new: 'bg-brand-50 text-brand-700 border-brand-200',
  ok: 'bg-accent-50 text-accent-700 border-accent-200',
};

function barColor(m: number) {
  if (m < 60) return 'bg-red-400';
  if (m < 80) return 'bg-amber-400';
  return 'bg-accent-500';
}

export function ConceptProgressCard({ topics, attempts, onPractice, now }: {
  topics: ProgressTopic[];
  attempts: ProgressAttempt[];
  onPractice: (ids: string[]) => void;
  now?: Date;
}) {
  const { t } = useLanguage();
  const [showAll, setShowAll] = useState(false);
  const progress = useMemo(() => buildConceptProgress(topics, attempts, now), [topics, attempts, now]);
  const practiced = progress.filter(p => p.attempts > 0).length;
  const practice = pickPracticeSet(progress, 3);
  const shown = showAll ? progress : progress.slice(0, 5);

  if (topics.length === 0) return null;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3" data-testid="card-concept-progress">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2 min-w-0">
          <Target className="w-4 h-4 text-brand-600" />
          {t('quiz.progress.title')}
          <HelpTip id="quiz.progress" />
        </h3>
        <span className="text-xs text-gray-500">{t('quiz.progress.practiced', { n: String(practiced), total: String(progress.length) })}</span>
        <button
          type="button"
          onClick={() => onPractice(practice.map(p => p.id))}
          className="ml-auto flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          data-testid="button-practice-weak"
        >
          <Sparkles className="w-4 h-4" />
          {t('quiz.progress.practiceButton')}
        </button>
      </div>

      <ul className="space-y-1.5">
        {shown.map(p => (
          <li key={p.id} className="flex items-center gap-3 min-w-0" data-testid={`row-progress-${p.id}`}>
            <span className="min-w-0 flex-1 truncate text-sm text-gray-800" title={p.name}>{p.name}</span>
            {p.mastery != null ? (
              <span className="flex w-28 shrink-0 items-center gap-2">
                <span className="h-2 flex-1 overflow-hidden rounded bg-gray-100">
                  <span className={`block h-full ${barColor(p.mastery)}`} style={{ width: `${Math.max(p.mastery, 4)}%` }} />
                </span>
                <span className="w-9 text-right text-xs text-gray-600">{p.mastery}%</span>
              </span>
            ) : (
              <span className="w-28 shrink-0 text-right text-xs text-gray-400">—</span>
            )}
            <span className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${REASON_STYLE[p.reason]}`} data-testid={`badge-progress-${p.id}`}>
              {p.reason === 'due' && p.daysSince != null
                ? t('quiz.progress.reason.dueDays', { n: String(p.daysSince) })
                : t(`quiz.progress.reason.${p.reason}`)}
            </span>
          </li>
        ))}
      </ul>

      {progress.length > 5 && (
        <button type="button" onClick={() => setShowAll(v => !v)} className="text-xs text-brand-700 hover:underline" data-testid="button-progress-all">
          {showAll ? t('quiz.progress.showLess') : t('quiz.progress.showAll', { n: String(progress.length) })}
        </button>
      )}
    </div>
  );
}
