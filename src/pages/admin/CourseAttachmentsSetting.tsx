import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Paperclip, Loader2, AlertTriangle } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { AdminHint } from '../../components/help/AdminHint';
import { HelpTip } from '../../components/help/HelpTip';

// Bijlagen in de chat per cursus (server/chatAttachments.js). Opt-in: staat
// standaard uit en gaat pas aan na een waarschuwing en een tweede bevestiging.
// Werkt alleen als de beheerder bijlagen platformbreed toestaat.

interface Props {
  courseId: string;
  courseName: string;
  on: boolean;
  token: string | undefined;
  onChanged: () => Promise<void> | void;
}

const WARNINGS = [
  'courseFeatures.attachments.warn.costs',
  'courseFeatures.attachments.warn.copyright',
  'courseFeatures.attachments.warn.privacy',
  'courseFeatures.attachments.warn.misread',
  'courseFeatures.attachments.warn.notStored',
  'courseFeatures.attachments.warn.adminSwitch',
] as const;

export function CourseAttachmentsSetting({ courseId, courseName, on, token, onChanged }: Props) {
  const { t } = useLanguage();
  const [platformEnabled, setPlatformEnabled] = useState<boolean | null>(null);
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/chat/attachments/config?courseId=${encodeURIComponent(courseId)}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const d = r.ok ? await r.json() : null;
        if (!cancelled) setPlatformEnabled(d ? !!d.platformEnabled : null);
      } catch {
        if (!cancelled) setPlatformEnabled(null);
      }
    })();
    return () => { cancelled = true; };
  }, [courseId, token, on]);

  const save = async (next: boolean) => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/courses/${courseId}/features`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ features: { attachments: next }, ...(next ? { confirmAttachments: true } : {}) }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setStep(0);
      setUnderstood(false);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const close = () => { setStep(0); setUnderstood(false); };

  return (
    <section className="rounded-xl border border-gray-200 bg-white px-4 py-3" data-testid="section-course-attachments">
      <div className="flex items-start gap-3">
        <Paperclip className={`mt-0.5 h-5 w-5 flex-shrink-0 ${on ? 'text-blue-600' : 'text-gray-400'}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 font-medium text-gray-900">
            {t('courseFeatures.attachments.title')}
            <HelpTip id="courseFeatures.attachments" />
          </p>
          <p className="text-sm text-gray-600">{t('courseFeatures.attachments.desc')}</p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {busy && <Loader2 className="h-4 w-4 animate-spin text-gray-400" aria-hidden />}
          <span className={`whitespace-nowrap text-xs font-medium ${on ? 'text-accent-700' : 'text-gray-500'}`}>
            {on ? t('courseFeatures.admin.on') : t('courseFeatures.admin.off')}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={t('courseFeatures.attachments.title')}
            disabled={busy}
            onClick={() => (on ? save(false) : setStep(1))}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-blue-600' : 'bg-gray-300'}`}
            data-testid="switch-feature-attachments"
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
      </div>
      {platformEnabled === false && (
        <AdminHint variant="warning" className="mt-2" testId="hint-attachments-platform-off">
          {on ? t('courseFeatures.attachments.platformOffOn') : t('courseFeatures.attachments.platformOff')}
        </AdminHint>
      )}
      {error && <p className="mt-2 text-sm text-red-700" data-testid="text-attachments-error">{error}</p>}

      {step > 0 && createPortal(
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" data-testid="dialog-attachments-confirm">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
            {step === 1 ? (
              <>
                <h3 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
                  <AlertTriangle className="h-5 w-5 text-amber-500" aria-hidden />
                  {t('courseFeatures.attachments.confirmTitle')}
                </h3>
                <p className="mt-2 text-sm text-gray-700">{t('courseFeatures.attachments.confirmIntro')}</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-700">
                  {WARNINGS.map(k => <li key={k}>{t(k)}</li>)}
                </ul>
                <label className="mt-4 flex items-start gap-2 text-sm font-medium text-gray-900">
                  <input
                    type="checkbox"
                    checked={understood}
                    onChange={(e) => setUnderstood(e.target.checked)}
                    className="mt-0.5"
                    data-testid="checkbox-attachments-understood"
                  />
                  <span className="min-w-0">{t('courseFeatures.attachments.understood')}</span>
                </label>
                <div className="mt-5 flex flex-wrap justify-end gap-2">
                  <button type="button" onClick={close} className="whitespace-nowrap rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                    {t('common.cancelAction')}
                  </button>
                  <button
                    type="button"
                    disabled={!understood}
                    onClick={() => setStep(2)}
                    className="whitespace-nowrap rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    data-testid="button-attachments-next"
                  >
                    {t('courseFeatures.attachments.next')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="text-lg font-semibold text-gray-900">
                  {t('courseFeatures.attachments.secondTitle', { course: courseName })}
                </h3>
                <p className="mt-2 text-sm text-gray-700">{t('courseFeatures.attachments.secondBody')}</p>
                <div className="mt-5 flex flex-wrap justify-end gap-2">
                  <button type="button" onClick={() => setStep(1)} className="whitespace-nowrap rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                    {t('courseFeatures.attachments.back')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => save(true)}
                    className="whitespace-nowrap rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    data-testid="button-attachments-confirm"
                  >
                    {busy ? t('common.busy') : t('courseFeatures.attachments.confirm')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </section>
  );
}
