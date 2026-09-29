import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Gavel, Loader2, Upload } from 'lucide-react';
import { useLanguage } from '../i18n';
import { PersonaAvatar } from './PersonaAvatar';

type Verdict = 'accepted' | 'conditional' | 'rejected';
type Badge = 'platina' | 'goud' | 'zilver' | 'brons';
interface FeedbackItem {
  productId: string;
  filename: string;
  createdAt: string;
  review: { id: string; verdict: Verdict; grade: number | null; reasoning: string; feed_forward: string | null; created_at: string } | null;
  badge: Badge | null;
}
interface EvaluatorFeedback {
  personaId: string;
  name: string;
  avatarEmoji: string | null;
  avatar?: unknown;
  deliverableLabel: string | null;
  maxReviews: number | null;
  used: number;
  remaining: number | null;
  canSubmit: boolean;
  items: FeedbackItem[];
}

const ACCEPT = '.txt,.md,.pdf,.docx,.pptx,.odt,.odp,.rtf,.csv,.xlsx,.ods';
const VERDICT: Record<Verdict, { Icon: typeof CheckCircle2; cls: string; key: 'room.review.verdictAccepted' | 'room.review.verdictConditional' | 'room.review.verdictRejected' }> = {
  accepted: { Icon: CheckCircle2, cls: 'bg-green-50 text-green-700 border-green-200', key: 'room.review.verdictAccepted' },
  conditional: { Icon: AlertTriangle, cls: 'bg-amber-50 text-amber-700 border-amber-200', key: 'room.review.verdictConditional' },
  rejected: { Icon: XCircle, cls: 'bg-red-50 text-red-700 border-red-200', key: 'room.review.verdictRejected' },
};
const BADGE_EMOJI: Record<Badge, string> = { platina: '💎', goud: '🥇', zilver: '🥈', brons: '🥉' };

/**
 * "Feedback op jullie werk": per beoordelaar het product waarover hij feedback
 * geeft, hoeveel rondes er nog over zijn, een knop om werk in te leveren en de
 * eerdere feedback. Een ronde telt alleen als er echt een oordeel kwam.
 */
export function ProductFeedbackPanel({ projectId, groupId, token, disabled = false, onInfo }: {
  projectId: string;
  groupId: string;
  token: string;
  /** Groep/project afgerond: alleen terugkijken. */
  disabled?: boolean;
  onInfo?: (msg: string) => void;
}) {
  const { t, lang } = useLanguage();
  const [evaluators, setEvaluators] = useState<EvaluatorFeedback[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/projects/${projectId}/groups/${groupId}/feedback`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json().catch(() => ({}));
      if (r.ok) setEvaluators(d.evaluators || []);
    } catch { /* aanvullend overzicht */ }
  }, [projectId, groupId, token]);

  useEffect(() => { void load(); }, [load]);

  const submit = async (ev: EvaluatorFeedback, file: File) => {
    setBusy(ev.personaId); setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      fd.append('lang', lang);
      const r = await fetch(`/api/projects/${projectId}/groups/${groupId}/personas/${ev.personaId}/feedback`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || t('room.feedback.failed'));
      onInfo?.(t('room.feedback.done', { name: ev.name }));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (!evaluators || evaluators.length === 0) return null;

  const fmtGrade = (g: number | null) => (g === null || !Number.isFinite(Number(g)) ? null : Number(g).toFixed(1).replace('.', t('common.locale') === 'nl-NL' ? ',' : '.'));

  return (
    <div className="mt-3 pt-3 border-t border-gray-100" data-testid="panel-product-feedback">
      <div className="text-xs font-semibold text-gray-700 mb-2 flex items-center gap-1">
        <Gavel className="w-3 h-3" /> {t('room.feedback.title')}
      </div>
      {error && <p className="mb-2 text-[11px] text-red-700" data-testid="text-feedback-error">{error}</p>}
      <div className="space-y-3">
        {evaluators.map(ev => (
          <div key={ev.personaId} className="rounded-lg border border-gray-200 p-2.5" data-testid={`feedback-evaluator-${ev.personaId}`}>
            <div className="flex items-start gap-2">
              <PersonaAvatar avatar={ev.avatar} name={ev.name} size={28} />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-gray-900">{ev.name}</div>
                {ev.deliverableLabel && (
                  <div className="text-[11px] text-gray-600">{t('room.feedback.about', { product: ev.deliverableLabel })}</div>
                )}
                <div className="text-[11px] text-gray-500" data-testid={`text-feedback-rounds-${ev.personaId}`}>
                  {ev.maxReviews === null
                    ? t('room.feedback.roundsUnlimited', { used: String(ev.used) })
                    : t('room.feedback.roundsLeft', { left: String(ev.remaining ?? 0), max: String(ev.maxReviews) })}
                </div>
              </div>
            </div>
            {!disabled && (
              ev.canSubmit ? (
                <label className={`mt-2 inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-medium ${busy ? 'bg-gray-100 text-gray-400' : 'cursor-pointer bg-purple-600 text-white hover:bg-purple-700'}`}>
                  {busy === ev.personaId ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                  {busy === ev.personaId ? t('room.feedback.reading', { name: ev.name }) : t('room.feedback.submit')}
                  <input
                    type="file"
                    accept={ACCEPT}
                    className="hidden"
                    disabled={!!busy}
                    onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void submit(ev, f); }}
                    data-testid={`input-feedback-upload-${ev.personaId}`}
                  />
                </label>
              ) : (
                <p className="mt-2 text-[11px] text-gray-500" data-testid={`text-feedback-used-up-${ev.personaId}`}>{t('room.feedback.usedUp')}</p>
              )
            )}
            {ev.items.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {ev.items.map((it, idx) => {
                  const meta = it.review ? VERDICT[it.review.verdict] : null;
                  const grade = it.review ? fmtGrade(it.review.grade) : null;
                  return (
                    <li key={it.productId} data-testid={`feedback-item-${it.productId}`}>
                      <details open={idx === 0} className="rounded bg-gray-50 px-2 py-1.5 text-[11px] text-gray-700">
                        <summary className="flex cursor-pointer flex-wrap items-center gap-1.5">
                          <span className="font-medium">{t('room.feedback.round', { n: String(ev.items.length - idx) })}</span>
                          <span className="min-w-0 truncate text-gray-500">{it.filename}</span>
                          {meta && (
                            <span className={`inline-flex items-center gap-0.5 rounded border px-1 py-0.5 text-[10px] ${meta.cls}`}>
                              <meta.Icon className="w-2.5 h-2.5" />{t(meta.key)}
                            </span>
                          )}
                          {grade && <span className="font-semibold tabular-nums">{grade}</span>}
                          {it.badge && <span title={t(`room.review.badge.${it.badge}`)}>{BADGE_EMOJI[it.badge]}</span>}
                        </summary>
                        {it.review && (
                          <div className="mt-1.5">
                            <div className="font-medium text-gray-600">{t('room.review.feedbackLabel')}</div>
                            <div className="whitespace-pre-wrap">{it.review.reasoning}</div>
                            {it.review.feed_forward && (
                              <>
                                <div className="mt-1 font-medium text-gray-600">{t('room.review.feedForwardLabel')}</div>
                                <div className="whitespace-pre-wrap">{it.review.feed_forward}</div>
                              </>
                            )}
                          </div>
                        )}
                      </details>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
