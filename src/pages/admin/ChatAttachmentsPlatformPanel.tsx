import { useEffect, useState } from 'react';
import { Paperclip, Loader2 } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { useAuth } from '../../contexts/AuthContext';
import { AdminHint } from '../../components/help/AdminHint';
import { HelpTip } from '../../components/help/HelpTip';
import { DEFAULT_LIMITS, type AttachmentLimits } from '../../lib/chatAttachments';

// Hoofdschakelaar van de beheerder voor bijlagen in de chat
// (GET/PUT /api/admin/chat-attachments, server/chatAttachments.js).
// Uit = de noodrem voor alle cursussen; de keuze per cursus blijft bewaard.

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];

interface Settings { enabled: boolean; detail: 'high' | 'low'; limits: AttachmentLimits }
interface Change { at: string; setting: string; value: Record<string, unknown>; course: string | null; by: string | null }

const LIMIT_KEYS: Array<keyof AttachmentLimits> = ['imagesPerMessage', 'perConversation', 'perDay', 'fileMb', 'fileChars', 'scanPages', 'imageMaxSide'];

export function ChatAttachmentsPlatformPanel() {
  const { t, lang } = useLanguage();
  const tk = (k: string, v?: Record<string, string>) => t(k as TKey, v);
  const { session } = useAuth();
  const token = session?.access_token;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [limits, setLimits] = useState<AttachmentLimits>(DEFAULT_LIMITS);
  const [coursesOn, setCoursesOn] = useState<Array<{ id: string; name: string }>>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = async () => {
    if (!token) return;
    try {
      const r = await fetch('/api/admin/chat-attachments', { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setSettings(d.settings);
      setLimits({ ...DEFAULT_LIMITS, ...(d.settings?.limits || {}) });
      setCoursesOn(d.coursesOn || []);
      setChanges(d.changes || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => { void load(); }, [token]);

  const put = async (body: Record<string, unknown>) => {
    if (!token) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const r = await fetch('/api/admin/chat-attachments', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      await load();
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setConfirmReset(false);
    }
  };

  if (!settings) {
    return (
      <div className="rounded-lg border border-gray-200 p-4 text-sm text-gray-500" data-testid="panel-chat-attachments-platform">
        {error || <Loader2 className="h-4 w-4 animate-spin" />}
      </div>
    );
  }

  const fmt = (iso: string) => new Date(iso).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' });
  const describe = (c: Change) => {
    if (c.setting === 'chat_attachments') {
      return tk(c.value?.on ? 'admin.chatAttachments.log.courseOn' : 'admin.chatAttachments.log.courseOff', { course: c.course || '?' });
    }
    const reset = Number(c.value?.resetCourses || 0);
    return reset > 0
      ? tk('admin.chatAttachments.log.reset', { n: String(reset) })
      : tk('admin.chatAttachments.log.platform', { state: c.value?.enabled ? t('courseFeatures.admin.on') : t('courseFeatures.admin.off') });
  };

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 p-4" data-testid="panel-chat-attachments-platform">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 font-semibold text-gray-900">
            <Paperclip className="h-4 w-4 text-blue-600" aria-hidden />
            {t('admin.chatAttachments.title')}
            <HelpTip id="chatAttachments.platform" />
          </h3>
          <p className="text-sm text-gray-600">{t('admin.chatAttachments.desc')}</p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {busy && <Loader2 className="h-4 w-4 animate-spin text-gray-400" aria-hidden />}
          <span className={`whitespace-nowrap text-xs font-medium ${settings.enabled ? 'text-accent-700' : 'text-gray-500'}`}>
            {settings.enabled ? t('courseFeatures.admin.on') : t('courseFeatures.admin.off')}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={settings.enabled}
            aria-label={t('admin.chatAttachments.title')}
            disabled={busy}
            onClick={() => put({ enabled: !settings.enabled })}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${settings.enabled ? 'bg-blue-600' : 'bg-gray-300'}`}
            data-testid="switch-chat-attachments-platform"
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${settings.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
      </div>

      <AdminHint variant="tip">{t('admin.chatAttachments.offKeeps')}</AdminHint>

      <div>
        <label className="block text-sm font-medium text-gray-900" htmlFor="chat-attachments-detail">{t('admin.chatAttachments.detail')}</label>
        <select
          id="chat-attachments-detail"
          value={settings.detail}
          disabled={busy}
          onChange={(e) => put({ detail: e.target.value })}
          className="mt-1 w-full max-w-md rounded-lg border border-gray-300 px-3 py-2 text-sm"
          data-testid="select-chat-attachments-detail"
        >
          <option value="high">{t('admin.chatAttachments.detailHigh')}</option>
          <option value="low">{t('admin.chatAttachments.detailLow')}</option>
        </select>
        {settings.detail === 'low' && (
          <AdminHint variant="warning" className="mt-2">{t('admin.chatAttachments.detailLowWarning')}</AdminHint>
        )}
      </div>

      <div>
        <p className="text-sm font-medium text-gray-900">{t('admin.chatAttachments.limits')}</p>
        <div className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(min(14rem,100%),1fr))] gap-2">
          {LIMIT_KEYS.map(k => (
            <label key={k} className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-1.5 text-sm">
              <span className="min-w-0 text-gray-700">{tk(`admin.chatAttachments.limit.${k}`)}</span>
              <input
                type="number"
                value={limits[k]}
                onChange={(e) => setLimits(prev => ({ ...prev, [k]: Number(e.target.value) }))}
                className="w-24 flex-shrink-0 rounded border border-gray-300 px-2 py-1 text-right"
                data-testid={`input-limit-${k}`}
              />
            </label>
          ))}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => put({ limits })}
          className="mt-2 whitespace-nowrap rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          data-testid="button-save-attachment-limits"
        >
          {t('common.save')}
        </button>
        {saved && <span className="ml-3 text-sm text-accent-700">{t('admin.chatAttachments.saved')}</span>}
      </div>

      <div>
        <p className="text-sm font-medium text-gray-900">{t('admin.chatAttachments.coursesOn', { n: String(coursesOn.length) })}</p>
        {coursesOn.length > 0 ? (
          <ul className="mt-1 list-disc pl-5 text-sm text-gray-700">
            {coursesOn.map(c => <li key={c.id}>{c.name}</li>)}
          </ul>
        ) : (
          <p className="text-sm text-gray-500">{t('admin.chatAttachments.noCourses')}</p>
        )}
        {coursesOn.length > 0 && (
          confirmReset ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-red-700">{t('admin.chatAttachments.resetConfirm', { n: String(coursesOn.length) })}</span>
              <button type="button" onClick={() => put({ resetCourses: true })} disabled={busy} className="whitespace-nowrap rounded-lg bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-700" data-testid="button-reset-attachments-confirm">
                {t('admin.chatAttachments.reset')}
              </button>
              <button type="button" onClick={() => setConfirmReset(false)} className="whitespace-nowrap rounded-lg border border-gray-300 px-3 py-1.5 text-gray-700">
                {t('common.cancelAction')}
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmReset(true)} className="mt-2 whitespace-nowrap text-sm text-red-700 underline hover:no-underline" data-testid="button-reset-attachments">
              {t('admin.chatAttachments.reset')}
            </button>
          )
        )}
      </div>

      {changes.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium text-gray-900">{t('admin.chatAttachments.history')}</summary>
          <ul className="mt-1 space-y-0.5 text-gray-700">
            {changes.map((c, i) => (
              <li key={i} className="min-w-0">
                <span className="text-gray-500">{fmt(c.at)}</span> · {describe(c)}{c.by ? ` · ${c.by}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}

      {error && <p className="text-sm text-red-700" data-testid="text-chat-attachments-platform-error">{error}</p>}
    </div>
  );
}
