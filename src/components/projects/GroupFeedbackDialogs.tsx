// De twee feedbackknoppen in de projectruimte (besluit 2026-11-26):
//   * "Feedback op ons proces": geen upload; de feedbackgever leest de gesprekken
//     met de personages en de checkpoints (nooit de groepschat).
//   * "Feedback op ons product": een voorlopige versie inleveren en feedback per
//     criterium krijgen.
// Elke soort heeft eigen rondes. "Definitief inleveren" is een derde, losse knop.
import { useRef, useState } from 'react';
import { Loader2, MessagesSquare, PackageCheck, X } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { PersonaAvatar } from '../PersonaAvatar';
import { ProductFeedbackPanel, RoundsLine, type FeedbackGiver } from '../ProductFeedbackPanel';

function Dialog({ title, icon, onClose, closeDisabled, testId, children }: {
  title: string; icon: React.ReactNode; onClose: () => void; closeDisabled?: boolean; testId: string; children: React.ReactNode;
}) {
  const { t } = useLanguage();
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
      <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-6">
        <div className="flex items-start justify-between gap-3 mb-3">
          <h3 className="text-lg font-bold flex items-center gap-2">{icon} {title}</h3>
          <button type="button" onClick={onClose} disabled={closeDisabled} aria-label={t('common.close')} className="p-1 rounded hover:bg-gray-100 disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** "Feedback op ons proces": uitleg wat de feedbackgever leest, de rondes en één knop. */
export function ProcessFeedbackDialog({ groupId, token, givers, onClose, onDone }: {
  groupId: string;
  token: string;
  givers: FeedbackGiver[];
  onClose: () => void;
  /** Klaar: aantal feedbackgevers dat feedback gaf (de ruimte laadt opnieuw). */
  onDone: (okCount: number) => void;
}) {
  const { t, lang } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Dezelfde aanvraag bij een nieuwe poging na een netwerkfout: de server doet hem niet dubbel.
  const requestId = useRef<string | null>(null);
  const processGivers = givers.filter(g => g.process);
  const canAsk = processGivers.some(g => g.process?.canSubmit);

  const ask = async () => {
    setBusy(true); setError(null);
    try {
      if (!requestId.current) {
        requestId.current = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      }
      const r = await fetch(`/api/projects/groups/${groupId}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ requestId: requestId.current, lang }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        // Niets om op te reageren: dan is er ook geen ronde gebruikt.
        if (d.code === 'nothingYet') { requestId.current = null; throw new Error(t('room.feedbackProcess.nothingYet')); }
        throw new Error(d.error || t('room.feedbackProcess.failed'));
      }
      requestId.current = null;
      onDone(((d.results || []) as Array<{ ok?: boolean }>).filter(x => x.ok).length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={t('room.feedbackProcess.button')} icon={<MessagesSquare className="w-5 h-5 text-violet-600" />} onClose={onClose} closeDisabled={busy} testId="dialog-process-feedback">
      <p className="text-sm text-gray-700">{t('room.feedbackProcess.intro')}</p>
      <p className="mt-2 text-xs text-gray-500">{t('room.feedbackProcess.notGroupChat')}</p>
      <ul className="mt-3 space-y-2">
        {processGivers.map(g => (
          <li key={g.personaId} className="flex items-center gap-2" data-testid={`process-giver-${g.personaId}`}>
            <PersonaAvatar avatar={g.avatar} name={g.name} size={28} />
            <div className="min-w-0">
              <div className="text-xs font-medium text-gray-900">{g.name}</div>
              {g.process && <RoundsLine rounds={g.process} testId={`text-process-rounds-${g.personaId}`} />}
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="mt-3 rounded bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700" data-testid="text-process-error">{error}</p>}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {!canAsk && <span className="mr-auto text-xs text-gray-500" data-testid="text-process-used-up">{t('room.feedback.usedUp')}</span>}
        <button type="button" onClick={onClose} disabled={busy} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg text-sm disabled:opacity-40">
          {t('common.close')}
        </button>
        <button
          type="button"
          onClick={() => void ask()}
          disabled={busy || !canAsk}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-violet-600 text-white hover:bg-violet-700 rounded-lg text-sm font-medium disabled:opacity-40"
          data-testid="button-ask-process-feedback"
        >
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          {busy ? t('room.assessing') : t('room.feedbackProcess.ask')}
        </button>
      </div>
    </Dialog>
  );
}

/** "Feedback op ons product": een voorlopige versie inleveren bij een feedbackgever. */
export function ProductFeedbackDialog({ projectId, groupId, token, givers, reload, onClose, onInfo }: {
  projectId: string;
  groupId: string;
  token: string;
  givers: FeedbackGiver[];
  reload: () => Promise<void> | void;
  onClose: () => void;
  onInfo: (msg: string) => void;
}) {
  const { t } = useLanguage();
  return (
    <Dialog title={t('room.feedbackProduct.button')} icon={<PackageCheck className="w-5 h-5 text-violet-600" />} onClose={onClose} testId="dialog-product-feedback">
      <p className="text-sm text-gray-700 mb-3">{t('room.feedbackProduct.intro')}</p>
      <ProductFeedbackPanel
        projectId={projectId} groupId={groupId} token={token}
        givers={givers} reload={reload} mode="submit"
        onInfo={(m) => { onInfo(m); onClose(); }}
      />
    </Dialog>
  );
}
