import { Megaphone, AlertTriangle, X } from 'lucide-react';
import { useLanguage } from '../i18n';
import { Tooltip } from './help/Tooltip';
import { useContentTranslation } from '../hooks/useContentTranslation';
import { dismissSystemMessage, type SystemMessage } from '../lib/systemMessages';

// Systeemberichten op het Dashboard (src/lib/systemMessages.ts). Wegklikken
// verbergt een bericht voorgoed voor deze gebruiker. De beheerder schrijft in
// één taal; de tekst wordt naar de taal van de gebruiker vertaald.

function MessageCard({ msg, translate }: { msg: SystemMessage; translate: boolean }) {
  const { t, lang } = useLanguage();
  // Geen vertaling in de voorbeeldweergave van het beheer (anders bij elke toetsaanslag).
  const tr = useContentTranslation(translate ? { title: { text: msg.title }, body: { text: msg.body } } : {});
  const title = tr.values.title ?? msg.title;
  const body = tr.values.body ?? msg.body;
  const warning = msg.kind === 'warning';
  const date = new Date(msg.starts_at).toLocaleDateString(lang, { day: 'numeric', month: 'long' });
  return (
    <div
      role={warning ? 'alert' : 'status'}
      className={`flex items-start gap-3 rounded-2xl border px-4 py-3 shadow-sm ${warning ? 'border-amber-300 bg-amber-50 text-amber-950' : 'border-blue-200 bg-blue-50 text-slate-900'}`}
      data-testid={`system-message-${msg.id}`}
    >
      {warning
        ? <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
        : <Megaphone className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" aria-hidden />}
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        {msg.body && <p className="mt-0.5 whitespace-pre-line text-sm">{body}</p>}
        <p className="mt-1 text-xs opacity-70">
          {t('systemMessages.from', { date })}
          {tr.isTranslated && (
            <>
              {' · '}
              <button type="button" className="underline hover:no-underline" onClick={() => tr.setShowOriginal(!tr.showOriginal)}>
                {tr.showOriginal ? t('systemMessages.showTranslation') : t('systemMessages.showOriginal')}
              </button>
            </>
          )}
        </p>
      </div>
      <Tooltip label={t('systemMessages.dismiss')}>
        <button
          type="button"
          onClick={() => { void dismissSystemMessage(msg.id); }}
          className="shrink-0 rounded-lg p-1 opacity-70 hover:bg-black/5 hover:opacity-100"
          data-testid={`button-dismiss-message-${msg.id}`}
        >
          <X className="h-4 w-4" />
        </button>
      </Tooltip>
    </div>
  );
}

export function SystemMessages({ messages, translate = true }: { messages: SystemMessage[]; translate?: boolean }) {
  if (messages.length === 0) return null;
  return (
    <section className="space-y-2" aria-live="polite" data-testid="system-messages">
      {messages.map((m) => <MessageCard key={m.id} msg={m} translate={translate} />)}
    </section>
  );
}
