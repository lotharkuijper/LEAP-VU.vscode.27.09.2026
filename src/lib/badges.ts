// Badges bij Ik leg uit en de Quiz (server/achievements/learningBadges.js).
// Hier alleen wat de browser nodig heeft om ze te tonen.

export const LEARNING_BADGE_KINDS = [
  'explain_clear', 'explain_growth', 'explain_flaws',
  'quiz_medal', 'quiz_mastered', 'quiz_comeback',
] as const;
export type LearningBadgeKind = typeof LEARNING_BADGE_KINDS[number];

/** Een badge die de server zojuist heeft toegekend. */
export interface EarnedBadge {
  kind: string;
  /** Het begrip. */
  label: string | null;
  /** Bij een quizmedaille: 1 brons, 2 zilver, 3 goud. */
  level: number | null;
}

export const isLearningBadge = (kind: string): kind is LearningBadgeKind =>
  (LEARNING_BADGE_KINDS as readonly string[]).includes(kind);

/** Kleur van de quizmedaille per moeilijkheid. */
const QUIZ_MEDAL_GRADIENT: Record<number, string> = {
  1: 'from-amber-500 to-orange-700',
  2: 'from-slate-300 to-slate-500',
  3: 'from-yellow-300 to-amber-500',
};

export const BADGE_GRADIENT: Record<LearningBadgeKind, string> = {
  explain_clear: 'from-sky-300 to-blue-600',
  explain_growth: 'from-emerald-300 to-teal-600',
  explain_flaws: 'from-fuchsia-300 to-purple-600',
  quiz_medal: QUIZ_MEDAL_GRADIENT[2],
  quiz_mastered: 'from-cyan-300 to-cyan-700',
  quiz_comeback: 'from-orange-300 to-rose-600',
};

export const badgeGradient = (kind: LearningBadgeKind, level: number | null) =>
  (kind === 'quiz_medal' ? QUIZ_MEDAL_GRADIENT[level ?? 2] || QUIZ_MEDAL_GRADIENT[2] : BADGE_GRADIENT[kind]);

/** Vertaalsleutel van de naam (een medaille heeft er één per kleur). */
export const badgeTitleKey = (kind: LearningBadgeKind, level: number | null) =>
  (kind === 'quiz_medal' ? `badges.quiz_medal.title.${level ?? 2}` : `badges.${kind}.title`);

/** Vertaalsleutel van de korte uitleg waarvoor je hem kreeg. */
export const badgeHintKey = (kind: LearningBadgeKind) => `badges.${kind}.hint`;
