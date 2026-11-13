import { Lightbulb, TrendingUp, SearchCheck, Medal, Target, RotateCcw, PartyPopper, type LucideIcon } from 'lucide-react';
import { useLanguage } from '../i18n';
import { badgeGradient, badgeHintKey, badgeTitleKey, isLearningBadge, type EarnedBadge, type LearningBadgeKind } from '../lib/badges';

const ICON: Record<LearningBadgeKind, LucideIcon> = {
  explain_clear: Lightbulb,
  explain_growth: TrendingUp,
  explain_flaws: SearchCheck,
  quiz_medal: Medal,
  quiz_mastered: Target,
  quiz_comeback: RotateCcw,
};

/** Het rondje van een badge bij Ik leg uit of de Quiz. */
export function LearningBadgeIcon({ kind, level, size = 'lg' }: { kind: LearningBadgeKind; level: number | null; size?: 'lg' | 'sm' }) {
  const Icon = ICON[kind];
  const box = size === 'lg' ? 'h-16 w-16 ring-4' : 'h-10 w-10 ring-2';
  const icon = size === 'lg' ? 'h-8 w-8' : 'h-5 w-5';
  return (
    <div className={`flex flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${badgeGradient(kind, level)} shadow-md ring-white ${box}`}>
      <Icon className={`${icon} text-white drop-shadow`} aria-hidden />
    </div>
  );
}

/** Naam van een badge in de taal van de student. */
export function useBadgeText() {
  const { t } = useLanguage();
  return {
    title: (kind: LearningBadgeKind, level: number | null) => t(badgeTitleKey(kind, level) as never),
    hint: (kind: LearningBadgeKind) => t(badgeHintKey(kind) as never),
  };
}

/** Melding direct na het verdienen van een of meer badges. */
export function EarnedBadgesNotice({ badges }: { badges: EarnedBadge[] }) {
  const { t } = useLanguage();
  const text = useBadgeText();
  const list = badges.filter((b): b is EarnedBadge & { kind: LearningBadgeKind } => isLearningBadge(b.kind));
  if (list.length === 0) return null;
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-left" role="status" data-testid="block-earned-badges">
      <p className="mb-3 flex items-center gap-2 font-semibold text-amber-900">
        <PartyPopper className="h-5 w-5" aria-hidden />
        {list.length === 1 ? t('badges.earned.one') : t('badges.earned.other', { count: String(list.length) })}
      </p>
      <ul className="space-y-3">
        {list.map((b, i) => (
          <li key={`${b.kind}-${b.level ?? ''}-${b.label ?? ''}-${i}`} className="flex items-center gap-3" data-testid={`earned-badge-${b.kind}`}>
            <LearningBadgeIcon kind={b.kind} level={b.level} size="sm" />
            <div className="min-w-0">
              <p className="font-semibold text-slate-900">
                {text.title(b.kind, b.level)}{b.label ? <span className="font-normal text-slate-700"> · {b.label}</span> : null}
              </p>
              <p className="text-sm text-slate-600">{text.hint(b.kind)}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-amber-800">
        {t('badges.earned.whereBefore')} <a href="/feedback?tab=achievements" className="font-medium underline hover:no-underline">{t('badges.earned.whereLink')}</a>{t('badges.earned.whereAfter')}
      </p>
    </div>
  );
}
