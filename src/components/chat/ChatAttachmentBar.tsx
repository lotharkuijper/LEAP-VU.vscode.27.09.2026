import { useRef } from 'react';
import { Paperclip, FileText, X, Loader2, AlertCircle, Info, Image as ImageIcon } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { Tooltip } from '../help/Tooltip';
import { ACCEPT, formatSize, type AttachmentMeta, type PendingAttachment } from '../../lib/chatAttachments';
import type { AttachmentError } from '../../hooks/useChatAttachments';

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];

/** Paperclipje: opent de bestandskiezer. Uitgeschakeld (met uitleg) als de beheerder bijlagen tijdelijk uit heeft. */
export function AttachButton({ available, disabled, onFiles }: { available: boolean; disabled?: boolean; onFiles: (files: File[]) => void }) {
  const { t } = useLanguage();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <Tooltip label={available ? t('chat.attachments.add') : t('chat.attachments.platformOff')}>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || !available}
          className="shrink-0 rounded-xl border border-gray-300 p-3 text-gray-600 transition-colors hover:border-green-500 hover:text-green-700 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="button-chat-attach"
        >
          <Paperclip className="h-5 w-5" />
        </button>
      </Tooltip>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        data-testid="input-chat-attach"
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

/** Wat klaarstaat om mee te sturen, plus melding en fouten. */
export function PendingAttachments({
  pending, busy, error, showNotice, onRemove, onClearError,
}: {
  pending: PendingAttachment[];
  busy: boolean;
  error: AttachmentError | null;
  showNotice: boolean;
  onRemove: (id: string) => void;
  onClearError: () => void;
}) {
  const { t } = useLanguage();
  if (pending.length === 0 && !busy && !error) return null;
  return (
    <div className="mb-2 space-y-2" data-testid="panel-chat-attachments">
      {showNotice && (
        <p className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900" data-testid="text-chat-attachments-notice">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">{t('chat.attachments.notice')}</span>
        </p>
      )}
      {(pending.length > 0 || busy) && (
        <ul className="flex flex-wrap gap-2">
          {pending.map(a => (
            <li key={a.id} className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-gray-200 bg-white py-1 pl-1 pr-2 text-xs text-gray-700" data-testid={`chip-attachment-${a.kind}`}>
              {a.kind === 'image' && a.dataUrl
                ? <img src={a.dataUrl} alt="" className="h-9 w-9 shrink-0 rounded object-cover" />
                : <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-gray-100"><FileText className="h-4 w-4 text-gray-500" /></span>}
              <span className="min-w-0">
                <span className="block max-w-[14rem] truncate font-medium">{a.name}</span>
                <span className="block text-gray-500">
                  {a.scanned
                    ? t('chat.attachments.scanned', { n: String(a.scanImages?.length || 0) })
                    : [a.pages ? t('chat.attachments.pages', { n: String(a.pages) }) : null, formatSize(a.size), a.truncated ? t('chat.attachments.truncated') : null].filter(Boolean).join(' · ')}
                </span>
              </span>
              <Tooltip label={t('chat.attachments.remove')}>
                <button type="button" onClick={() => onRemove(a.id)} className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700" data-testid="button-remove-attachment">
                  <X className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            </li>
          ))}
          {busy && (
            <li className="flex items-center gap-2 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-xs text-gray-500" data-testid="chip-attachment-busy">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('chat.attachments.processing')}
            </li>
          )}
        </ul>
      )}
      {pending.length > 0 && (
        <p className="text-xs text-gray-500">{t('chat.attachments.explainHint')}</p>
      )}
      {error && (
        <p className="flex items-start gap-2 text-xs text-red-700" data-testid="text-chat-attachments-error">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{t(error.key as TKey, error.params)}</span>
          <button type="button" onClick={onClearError} className="shrink-0 underline hover:no-underline">{t('common.close')}</button>
        </p>
      )}
    </div>
  );
}

/** Labels bij een verstuurd studentbericht; miniaturen alleen zolang de chat open is. */
export function SentAttachments({ meta, previews }: { meta: AttachmentMeta[]; previews?: string[] }) {
  const { t } = useLanguage();
  if (meta.length === 0) return null;
  return (
    <div className="mt-2 space-y-1.5" data-testid="list-sent-attachments">
      {previews && previews.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {previews.map((src, i) => <img key={i} src={src} alt="" className="h-16 max-w-[8rem] rounded border border-white/40 object-cover" />)}
        </div>
      )}
      {meta.map((m, i) => (
        <p key={i} className="flex items-center gap-1.5 text-xs text-white/90">
          {m.kind === 'image' ? <ImageIcon className="h-3.5 w-3.5 shrink-0" /> : <FileText className="h-3.5 w-3.5 shrink-0" />}
          <span className="min-w-0 truncate">
            {t(m.kind === 'image' ? 'chat.attachments.labelImage' : 'chat.attachments.labelFile', { name: m.name })}
          </span>
        </p>
      ))}
    </div>
  );
}
