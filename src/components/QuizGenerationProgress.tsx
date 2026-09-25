import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useLanguage } from '../i18n';
import type { QuestionType } from '../services/llm.service';
import type { QuizProgressPhase } from '../services/quiz-mix.service';
import { roundSeconds } from '../lib/quizTimeEstimate';

export type GenerationPhase = 'searching' | QuizProgressPhase;

// Aantal speelse varianten per fase in de vertalingen (quiz.progress.<fase>.<n>).
const MESSAGE_COUNT: Record<Exclude<GenerationPhase, 'writing' | 'done'>, number> = {
  searching: 3,
  checking: 4,
  repairing: 3,
  replacing: 3,
};
const WRITING_COUNT = 3; // per vraagvorm: quiz.progress.writing.<type>.<n>
const ROTATE_MS = 3500;

/**
 * Voortgang = max(tijd t.o.v. schatting, aandeel goedgekeurde vragen). De
 * tijdcomponent stopt op 90% zodat de balk nooit "vol" is voordat de vragen er
 * echt zijn; de vraagcomponent maakt de laatste stap zichtbaar.
 */
export function progressFraction(elapsedSec: number, expectedSec: number, approved: number, target: number): number {
  const byTime = expectedSec > 0 ? Math.min(0.9, (elapsedSec / expectedSec) * 0.9) : 0;
  const byQuestions = target > 0 ? Math.min(0.97, (approved / target) * 0.97) : 0;
  return Math.max(0.03, byTime, byQuestions);
}

export function QuizGenerationProgress(props: {
  phase: GenerationPhase;
  approved: number;
  target: number;
  expectedSeconds: number;
  startedAt: number;
  questionType: QuestionType;
}) {
  const { t } = useLanguage();
  const tk = (key: string, vars?: Record<string, string>) => t(key as Parameters<typeof t>[0], vars);
  const [now, setNow] = useState(() => Date.now());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 250);
    const rotate = setInterval(() => setTick(x => x + 1), ROTATE_MS);
    return () => { clearInterval(clock); clearInterval(rotate); };
  }, []);
  // Nieuwe fase → begin bij de eerste tekst van die fase.
  useEffect(() => { setTick(0); }, [props.phase]);

  const elapsed = Math.max(0, (now - props.startedAt) / 1000);
  const pct = Math.round(progressFraction(elapsed, props.expectedSeconds, props.approved, props.target) * 100);
  const remaining = props.expectedSeconds - elapsed;

  let message: string;
  if (props.phase === 'writing') {
    message = tk(`quiz.progress.writing.${props.questionType}.${(tick % WRITING_COUNT) + 1}`);
  } else if (props.phase === 'done') {
    message = tk('quiz.progress.done');
  } else {
    message = tk(`quiz.progress.${props.phase}.${(tick % MESSAGE_COUNT[props.phase]) + 1}`);
  }

  return (
    <div
      className="rounded-2xl border border-cyan-200 bg-gradient-to-br from-cyan-50 via-white to-fuchsia-50 p-5 space-y-3"
      role="status"
      aria-live="polite"
      data-testid="block-quiz-progress"
    >
      <div className="flex items-center justify-between text-sm">
        <span className="font-semibold text-cyan-900 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-fuchsia-500 animate-pulse" />
          {tk('quiz.progress.title')}
        </span>
        <span className="text-xs text-gray-600" data-testid="text-quiz-progress-count">
          {tk('quiz.progress.count', { approved: String(Math.min(props.approved, props.target)), target: String(props.target) })}
        </span>
      </div>
      <div
        className="h-3 rounded-full bg-cyan-100 overflow-hidden"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-cyan-500 via-sky-500 to-fuchsia-500 transition-all duration-500 ease-out"
          style={{ width: `${pct}%` }}
          data-testid="bar-quiz-progress"
        />
      </div>
      <p className="text-sm text-gray-800 min-h-[1.25rem]" data-testid="text-quiz-progress-message">{message}</p>
      <p className="text-xs text-gray-500" data-testid="text-quiz-progress-remaining">
        {remaining > 2
          ? tk('quiz.progress.remaining', { seconds: String(roundSeconds(remaining)) })
          : elapsed < props.expectedSeconds * 1.3
            ? tk('quiz.progress.almostDone')
            : tk('quiz.progress.takingLonger')}
      </p>
    </div>
  );
}
