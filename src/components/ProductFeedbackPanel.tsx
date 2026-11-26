import { useCallback, useEffect, useState } from 'react';
import { MessageSquare, Loader2, Upload } from 'lucide-react';
import { useLanguage } from '../i18n';
import { PersonaAvatar } from './PersonaAvatar';
import { SaveToJournalButton } from './projects/SaveToJournalButton';

interface FeedbackItem {
  productId: string;
  filename: string;
  createdAt: string;
  /** Zuiver formatief (2026-11-10): geen cijfer, oordeel of badge. */
  review: { id: string; reasoning: string; feed_forward: string | null; created_at: string } | null;
  /** Staat dit oordeel al in MIJN leerdagboek? */
  journalSaved?: boolean;
}
export interface RoundsInfo {
  maxReviews: number | null;
  used: number;
  remaining: number | null;
  canSubmit: boolean;
}
/** Een feedbackgever zoals GET …/groups/:groupId/feedback hem teruggeeft. */
export interface FeedbackGiver extends RoundsInfo {
  personaId: string;
  name: string;
  avatarEmoji: string | null;
  avatar?: unknown;
  deliverableLabel: string | null;
  /** Geeft feedback op het product (upload); de rondes hierboven gelden daarvoor. */
  product: boolean;
  items: FeedbackItem[];
  /** Feedback op het proces (geen upload), met eigen rondes; null = geeft hij niet. */
  process: RoundsInfo | null;
}

/** Feedbackgevers van deze groep met per soort de rondes (gedeeld door beide knoppen en de rechterkolom). */
export function useGroupFeedback(projectId: string | undefined, groupId: string | undefined, token: string | null | undefined) {
  const [givers, setGivers] = useState<FeedbackGiver[]>([]);
  const reload = useCallback(async () => {
    if (!projectId || !groupId || !token) return;
    try {
      const r = await fetch(`/api/projects/${projectId}/groups/${groupId}/feedback`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json().catch(() => ({}));
      if (r.ok) setGivers(d.evaluators || []);
    } catch { /* aanvullend overzicht */ }
  }, [projectId, groupId, token]);
  useEffect(() => { void reload(); }, [reload]);
  return { givers, reload };
}

/** "Nog 2 van 3 feedbackrondes" of "Onbeperkt · 1 keer gevraagd". */
export function RoundsLine({ rounds, testId }: { rounds: RoundsInfo; testId?: string }) {
  const { t } = useLanguage();
  return (
    <div className="text-[11px] text-gray-500" data-testid={testId}>
      {rounds.maxReviews === null
        ? t('room.feedback.roundsUnlimited', { used: String(rounds.used) })
        : t('room.feedback.roundsLeft', { left: String(rounds.remaining ?? 0), max: String(rounds.maxReviews) })}
    </div>
  );
}

const ACCEPT = '.txt,.md,.pdf,.docx,.pptx,.odt,.odp,.rtf,.csv,.xlsx,.ods';

/**
 * Feedback op het (voorlopige) product, besluit 2026-11-26.
 *  * mode "submit" (venster achter de knop "Feedback op ons product"): per
 *    feedbackgever waarover hij feedback geeft, hoeveel rondes er nog zijn en een
 *    knop om een voorlopige versie in te leveren.
 *  * mode "history" (rechterkolom): alleen de eerdere feedback, om terug te lezen.
 * Een ronde telt alleen als er echt feedback kwam.
 */
export function ProductFeedbackPanel({ projectId, groupId, token, givers, reload, mode, onInfo, journalOn = true }: {
  projectId: string;
  groupId: string;
  token: string;
  givers: FeedbackGiver[];
  reload: () => Promise<void> | void;
  mode: 'submit' | 'history';
  onInfo?: (msg: string) => void;
  /** Leerdagboek aan in deze cursus: dan "Bewaar in mijn leerdagboek". */
  journalOn?: boolean;
}) {
  const { t, lang } = useLanguage();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (ev: FeedbackGiver, file: File) => {
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
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const shown = mode === 'submit'
    ? givers.filter(ev => ev.product)
    : givers.filter(ev => ev.items.some(it => it.review));
  if (shown.length === 0) return null;

  return (
    <div className={mode === 'history' ? 'mt-3 pt-3 border-t border-gray-100' : ''} data-testid={mode === 'history' ? 'panel-product-feedback' : 'panel-product-feedback-submit'}>
      {mode === 'history' && (
        <div className="text-xs font-semibold text-gray-700 mb-2 flex items-center gap-1">
          <MessageSquare className="w-3 h-3" /> {t('room.feedbackProduct.historyTitle')}
        </div>
      )}
      {error && <p className="mb-2 text-xs text-red-700" data-testid="text-feedback-error">{error}</p>}
      <div className="space-y-3">
        {shown.map(ev => (
          <div key={ev.personaId} className="rounded-lg border border-gray-200 p-2.5" data-testid={`feedback-evaluator-${ev.personaId}`}>
            <div className="flex items-start gap-2">
              <PersonaAvatar avatar={ev.avatar} name={ev.name} size={28} />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-gray-900">{ev.name}</div>
                {ev.deliverableLabel && (
                  <div className="text-[11px] text-gray-600">{t('room.feedback.about', { product: ev.deliverableLabel })}</div>
                )}
                {mode === 'submit' && <RoundsLine rounds={ev} testId={`text-feedback-rounds-${ev.personaId}`} />}
              </div>
            </div>
            {mode === 'submit' && (
              ev.canSubmit ? (
                <label className={`mt-2 inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium ${busy ? 'bg-gray-100 text-gray-400' : 'cursor-pointer bg-violet-600 text-white hover:bg-violet-700'}`}>
                  {busy === ev.personaId ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                  {busy === ev.personaId ? t('room.feedback.reading', { name: ev.name }) : t('room.feedbackProduct.choose')}
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
            {mode === 'history' && ev.items.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {ev.items.map((it, idx) => (
                  <li key={it.productId} data-testid={`feedback-item-${it.productId}`}>
                    <details open={idx === 0} className="rounded bg-gray-50 px-2 py-1.5 text-[11px] text-gray-700">
                      <summary className="flex cursor-pointer flex-wrap items-center gap-1.5">
                        <span className="font-medium">{t('room.feedback.round', { n: String(ev.items.length - idx) })}</span>
                        <span className="min-w-0 truncate text-gray-500">{it.filename}</span>
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
                          {journalOn && (
                            <SaveToJournalButton
                              groupId={groupId} token={token} source="review" id={it.review.id}
                              saved={!!it.journalSaved}
                              onSaved={() => void reload()}
                              testId={'button-journal-review-' + it.review.id}
                            />
                          )}
                        </div>
                      )}
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
