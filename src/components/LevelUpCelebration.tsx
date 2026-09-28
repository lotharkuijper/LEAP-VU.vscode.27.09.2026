import { useEffect, useMemo, useRef } from 'react';
import { Trophy, X, Sparkles } from 'lucide-react';
import { useLanguage } from '../i18n';

import type { ReadinessResult } from '../lib/readiness';
export type { ReadinessResult };

const COLORS = ['#f97316', '#fbbf24', '#10b981', '#0b72c2', '#a78bfa', '#f472b6', '#22d3ee', '#facc15'];
const PIECES = 110;

/** Vaste, maar gevarieerde confetti (geen Math.random in render: rustig bij her-renders). */
function confettiPieces() {
  return Array.from({ length: PIECES }, (_, i) => {
    const r = (n: number) => ((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
    return {
      left: `${r(1) * 100}%`,
      delay: `${r(2) * 0.9}s`,
      duration: `${2.4 + r(3) * 2.2}s`,
      drift: `${(r(4) - 0.5) * 220}px`,
      spin: `${360 + r(5) * 720}deg`,
      size: 6 + Math.round(r(6) * 7),
      round: r(7) > 0.6,
      color: COLORS[i % COLORS.length],
    };
  });
}

/**
 * Het feest bij een positief oordeel op "klaar voor een hoger niveau?":
 * confetti over het hele scherm, een trofee die in beeld springt en de keuze
 * om het niveau echt te verhogen. De student blijft de baas: pas na
 * "Ja, ik ga naar …" gaat het niveau omhoog.
 */
export function LevelUpCelebration({ result, onAccept, onClose }: {
  result: ReadinessResult;
  onAccept: (level: number) => void;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const pieces = useMemo(confettiPieces, []);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const levelLabel = t(`learningLevel.level${result.nextLevel}.label` as never);

  useEffect(() => {
    acceptRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" data-testid="levelup-celebration">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px] leap-fade-in" onClick={onClose} aria-hidden />
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        {pieces.map((p, i) => (
          <span
            key={i}
            className="leap-confetti-fall"
            style={{
              left: p.left, width: p.size, height: p.round ? p.size : p.size * 0.45,
              borderRadius: p.round ? '9999px' : '2px', background: p.color,
              animationDelay: p.delay, animationDuration: p.duration,
              ['--leap-drift' as string]: p.drift, ['--leap-spin' as string]: p.spin,
            }}
          />
        ))}
      </div>

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="levelup-title"
        className="leap-card-pop relative w-full max-w-md rounded-3xl bg-white p-7 pt-9 text-center shadow-2xl ring-1 ring-accent-200"
      >
        <button type="button" onClick={onClose} aria-label={t('common.close')} className="absolute right-3 top-3 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
          <X className="h-4 w-4" />
        </button>
        <div className="relative mx-auto mb-4 h-28 w-28">
          <div className="leap-rays absolute inset-[-28px] rounded-full" aria-hidden />
          <div className="leap-trophy relative flex h-28 w-28 items-center justify-center rounded-full bg-gradient-to-br from-accent-300 via-accent-400 to-accent-600 shadow-lg ring-4 ring-white">
            <Trophy className="h-14 w-14 text-white drop-shadow" aria-hidden />
          </div>
          <Sparkles className="leap-twinkle absolute -right-2 -top-1 h-7 w-7 text-amber-400" aria-hidden />
          <Sparkles className="leap-twinkle absolute -left-3 bottom-2 h-5 w-5 text-brand-400" style={{ animationDelay: '0.4s' }} aria-hidden />
        </div>
        <h2 id="levelup-title" className="text-2xl font-extrabold text-slate-900">
          {t('achievements.celebrate.title', { level: levelLabel })}
        </h2>
        {result.topic && (
          <p className="mt-1 text-sm font-semibold text-accent-700" data-testid="levelup-topic">{result.topic}</p>
        )}
        <p className="mt-3 text-sm text-slate-600">{t('achievements.celebrate.body')}</p>
        {result.achievement && (
          <div className="mx-auto mt-4 inline-flex items-center gap-2 rounded-full bg-accent-50 px-3 py-1.5 text-xs font-bold text-accent-800 ring-1 ring-accent-200" data-testid="levelup-achievement">
            🏆 {result.achievement.isNew
              ? t('achievements.celebrate.earned')
              : t('achievements.celebrate.alreadyEarned')}
          </div>
        )}
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button
            ref={acceptRef}
            type="button"
            onClick={() => onAccept(result.nextLevel)}
            className="rounded-xl bg-gradient-to-r from-accent-500 to-accent-600 px-5 py-2.5 text-sm font-bold text-white shadow-md hover:from-accent-600 hover:to-accent-700 focus:outline-none focus:ring-2 focus:ring-accent-400 focus:ring-offset-2"
            data-testid="button-levelup-accept"
          >
            {t('achievements.celebrate.accept', { level: levelLabel })}
          </button>
          <button type="button" onClick={onClose} className="btn-secondary" data-testid="button-levelup-later">
            {t('achievements.celebrate.later')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Kleine melding bij "bijna", "nog niet" of een oordeel dat (nog) niet telt. */
export function ReadinessNotice({ result, onClose }: { result: ReadinessResult; onClose: () => void }) {
  const { t } = useLanguage();
  useEffect(() => {
    const timer = setTimeout(onClose, 9000);
    return () => clearTimeout(timer);
  }, [onClose]);
  const key =
    result.verdict === 'ready' && result.reason === 'too_short' ? 'achievements.notice.tooShort'
    : result.reason === 'max_level' ? 'achievements.notice.maxLevel'
    : result.verdict === 'almost' ? 'achievements.notice.almost'
    : 'achievements.notice.notYet';
  const almost = result.verdict === 'almost' || result.reason === 'too_short';
  return (
    <div
      role="status"
      aria-live="polite"
      className="leap-card-pop mb-2 flex items-start gap-3 rounded-xl bg-white px-3 py-2.5 text-sm shadow-md ring-1 ring-accent-200"
      data-testid="readiness-notice"
    >
      <span
        className="relative mt-0.5 h-7 w-7 flex-shrink-0 rounded-full"
        style={{ background: `conic-gradient(rgb(var(--leap-accent-500)) ${almost ? 75 : 35}%, rgb(var(--leap-ink-200)) 0)` }}
        aria-hidden
      >
        <span className="absolute inset-[4px] rounded-full bg-white" />
      </span>
      <p className="flex-1 text-slate-700">{t(key as never)}</p>
      <button type="button" onClick={onClose} aria-label={t('common.close')} className="rounded p-0.5 text-slate-400 hover:text-slate-600">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
