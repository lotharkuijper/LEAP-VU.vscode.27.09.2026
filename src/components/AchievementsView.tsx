import { useEffect, useMemo, useState } from 'react';
import { Trophy, Lock, ArrowRight, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import { useLearningLevel, LEVEL_MAX } from '../hooks/useLearningLevel';
import { useLanguage } from '../i18n';

export interface AchievementRow {
  id: string;
  course_id: string | null;
  kind: string;
  topic_label: string | null;
  level: number | null;
  evidence_journal_id: string | null;
  earned_at: string;
}

/** Medaillekleur per niveau: Beginner brons, Gemiddeld zilver, Gevorderd goud, Expert platina. */
export const LEVEL_MEDAL: Record<number, string> = {
  1: 'from-teal-300 to-teal-500',
  2: 'from-amber-500 to-orange-700',
  3: 'from-slate-300 to-slate-500',
  4: 'from-yellow-300 to-amber-500',
  5: 'from-cyan-200 via-sky-300 to-violet-400',
};

export interface LockedAchievement { key: string; topic: string | null; level: number }

/**
 * Pure: welke achievements liggen voor de hand om als volgende te verdienen?
 * Het volgende cursusniveau, en per al verdiend onderwerp het niveau erboven.
 */
export function nextToEarn(rows: AchievementRow[], courseId: string | null, currentLevel: number, max = 6): LockedAchievement[] {
  if (!courseId) return [];
  const mine = rows.filter(r => r.kind === 'level' && r.course_id === courseId && r.level);
  const has = new Set(mine.map(r => `${(r.topic_label || '').toLowerCase()}|${r.level}`));
  const out: LockedAchievement[] = [];
  if (currentLevel < LEVEL_MAX) out.push({ key: `course|${currentLevel + 1}`, topic: null, level: currentLevel + 1 });
  const bestPerTopic = new Map<string, { topic: string; level: number }>();
  for (const r of mine) {
    if (!r.topic_label) continue;
    const k = r.topic_label.toLowerCase();
    if ((bestPerTopic.get(k)?.level ?? 0) < (r.level as number)) bestPerTopic.set(k, { topic: r.topic_label, level: r.level as number });
  }
  for (const { topic, level } of bestPerTopic.values()) {
    const next = level + 1;
    if (next <= LEVEL_MAX && !has.has(`${topic.toLowerCase()}|${next}`)) out.push({ key: `${topic}|${next}`, topic, level: next });
  }
  return out.slice(0, max);
}

/** De prijzenkast in het leerdagboek. */
export function AchievementsView({ onOpenEvidence }: { onOpenEvidence: (journalEntryId: string) => void }) {
  const { profile } = useAuth();
  const { activeCourseId } = useActiveCourse();
  const { level: currentLevel } = useLearningLevel(activeCourseId);
  const { t, lang } = useLanguage();
  const [rows, setRows] = useState<AchievementRow[] | null>(null);
  const [courseNames, setCourseNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!profile?.id) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('student_achievements' as never)
        .select('id, course_id, kind, topic_label, level, evidence_journal_id, earned_at')
        .eq('user_id', profile.id)
        .order('earned_at', { ascending: false });
      if (cancelled) return;
      const list = (error ? [] : (data as unknown as AchievementRow[])) || [];
      setRows(list);
      const ids = [...new Set(list.map(r => r.course_id).filter(Boolean))] as string[];
      if (ids.length) {
        const { data: courses } = await supabase.from('courses').select('id, name').in('id', ids);
        if (!cancelled) setCourseNames(Object.fromEntries(((courses as { id: string; name: string }[]) || []).map(c => [c.id, c.name])));
      }
    })();
    return () => { cancelled = true; };
  }, [profile?.id]);

  const locked = useMemo(() => nextToEarn(rows || [], activeCourseId ?? null, currentLevel), [rows, activeCourseId, currentLevel]);
  const levelLabel = (n: number) => t(`learningLevel.level${n}.label` as never);
  const fmt = (iso: string) => new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));

  if (rows === null) {
    return <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-teal-600" /></div>;
  }

  return (
    <div className="space-y-6" data-testid="achievements-view">
      <div className="chic-card flex items-center gap-4 p-5">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-accent-300 to-accent-600 shadow-md">
          <Trophy className="h-7 w-7 text-white" aria-hidden />
        </div>
        <div>
          <h2 className="text-xl font-bold text-slate-900">{t('achievements.title')}</h2>
          <p className="text-sm text-slate-600" data-testid="achievements-summary">
            {rows.length === 1
              ? t('achievements.summary.one', { count: String(rows.length) })
              : t('achievements.summary.other', { count: String(rows.length) })}
          </p>
        </div>
      </div>

      {rows.length === 0 && (
        <p className="rounded-2xl bg-accent-50 px-5 py-4 text-sm text-accent-900 ring-1 ring-accent-200" data-testid="achievements-empty">
          {t('achievements.empty')}
        </p>
      )}

      {rows.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(r => (
            <li key={r.id} className="chic-card flex flex-col items-center p-5 text-center" data-testid={`achievement-${r.id}`}>
              <div className={`mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br ${LEVEL_MEDAL[r.level ?? 2] || LEVEL_MEDAL[2]} shadow-md ring-4 ring-white`}>
                <Trophy className="h-8 w-8 text-white drop-shadow" aria-hidden />
              </div>
              <h3 className="font-bold text-slate-900">{t('achievements.levelTitle', { level: levelLabel(r.level ?? 2) })}</h3>
              <p className="mt-0.5 text-sm font-semibold text-accent-700">{r.topic_label || t('achievements.wholeCourse')}</p>
              {r.course_id && courseNames[r.course_id] && (
                <p className="mt-0.5 text-xs text-slate-500">{courseNames[r.course_id]}</p>
              )}
              <p className="mt-2 text-xs text-slate-500">{t('achievements.earnedOn', { date: fmt(r.earned_at) })}</p>
              {r.evidence_journal_id && (
                <button
                  type="button"
                  onClick={() => onOpenEvidence(r.evidence_journal_id as string)}
                  className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-teal-700 hover:underline"
                  data-testid={`button-evidence-${r.id}`}
                >
                  {t('achievements.viewEvidence')}<ArrowRight className="h-4 w-4" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {locked.length > 0 && (
        <section>
          <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">{t('achievements.locked')}</h3>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {locked.map(l => (
              <li key={l.key} className="flex flex-col items-center rounded-2xl border-2 border-dashed border-slate-200 bg-white/50 p-5 text-center" data-testid="achievement-locked">
                <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-slate-100">
                  <Lock className="h-7 w-7 text-slate-400" aria-hidden />
                </div>
                <h4 className="font-semibold text-slate-500">{t('achievements.levelTitle', { level: levelLabel(l.level) })}</h4>
                <p className="mt-0.5 text-sm text-slate-400">{l.topic || t('achievements.wholeCourse')}</p>
                <p className="mt-2 text-xs text-slate-400">{t('achievements.lockedHint')}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
