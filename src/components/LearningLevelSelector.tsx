import { useEffect, useState } from 'react';
import { GraduationCap } from 'lucide-react';
import { useLanguage } from '../i18n';
import { LEVELS } from '../hooks/useLearningLevel';

interface LearningLevelSelectorProps {
  value: number;
  onChange: (level: number) => void;
  disabled?: boolean;
  className?: string;
  /** Compacte variant: kleinere knoppen, geen helptekst. */
  compact?: boolean;
}

/** Hoe lang het "niveau omhoog"-moment zichtbaar blijft (ms). */
export const LEVEL_UP_MS = 2800;
const CONFETTI = ['#f97316', '#fbbf24', '#10b981', '#0b72c2', '#a78bfa', '#f472b6', '#f97316', '#fbbf24', '#10b981', '#0b72c2', '#a78bfa', '#f472b6'];

// Task #296: zelfgekozen leerniveau (5 stappen, beginner→expert). De student
// bepaalt het niveau; de uitleg van tutor/persona's past zich erop aan. Gaat
// de student een niveau omhoog, dan volgt een klein feestje (confetti + pil
// met het nieuwe niveau). Omlaag gaan mag altijd, zonder toeters en bellen.
export function LearningLevelSelector({
  value,
  onChange,
  disabled,
  className,
  compact,
}: LearningLevelSelectorProps) {
  const { t } = useLanguage();
  const [celebrate, setCelebrate] = useState<{ level: number; key: number } | null>(null);

  useEffect(() => {
    if (!celebrate) return;
    const timer = setTimeout(() => setCelebrate(null), LEVEL_UP_MS);
    return () => clearTimeout(timer);
  }, [celebrate]);

  const choose = (lvl: number) => {
    if (lvl > value) setCelebrate({ level: lvl, key: Date.now() });
    else setCelebrate(null);
    onChange(lvl);
  };

  return (
    <div className={`relative ${className ?? ''}`} data-testid="learning-level-selector">
      {celebrate && (
        <div
          key={celebrate.key}
          role="status"
          aria-live="polite"
          className="leap-levelup absolute bottom-full left-1/2 mb-2 z-20 pointer-events-none"
          data-testid="learning-level-up"
        >
          <div className="relative whitespace-nowrap rounded-full bg-gradient-to-r from-accent-400 to-accent-500 px-3.5 py-1.5 text-xs font-bold text-white shadow-lg">
            🎉 {t('learningLevel.levelUp', { label: t(`learningLevel.level${celebrate.level}.label` as never) })}
            {CONFETTI.map((color, i) => (
              <span
                key={i}
                aria-hidden
                className="leap-confetti"
                style={{ background: color, ['--leap-angle' as string]: `${(360 / CONFETTI.length) * i}deg` }}
              />
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-1.5 mb-1 text-xs font-medium text-gray-600">
        <GraduationCap className="w-3.5 h-3.5 shrink-0" />
        <span>{t('learningLevel.title')}</span>
      </div>
      <div className="flex gap-1" role="group" aria-label={t('learningLevel.title')}>
        {LEVELS.map((lvl) => {
          const active = value === lvl;
          return (
            <button
              key={lvl}
              type="button"
              disabled={disabled}
              onClick={() => choose(lvl)}
              title={t(`learningLevel.level${lvl}.desc`)}
              aria-pressed={active}
              className={`flex-1 ${compact ? 'px-1.5 py-1' : 'px-2 py-1.5'} rounded-md text-xs border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                active
                  ? `bg-blue-600 text-white border-blue-600 font-medium ${celebrate?.level === lvl ? 'leap-levelup-pop' : ''}`
                  : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400 hover:text-blue-600'
              }`}
              data-testid={`button-learning-level-${lvl}`}
            >
              {t(`learningLevel.level${lvl}.label`)}
            </button>
          );
        })}
      </div>
      {!compact && (
        <p className="mt-1 text-[11px] leading-snug text-gray-400">{t('learningLevel.help')}</p>
      )}
    </div>
  );
}
