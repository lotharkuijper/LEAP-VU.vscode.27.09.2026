import { useState } from 'react';
import { createPortal } from 'react-dom';
import { DoorOpen, Loader2, AlertTriangle } from 'lucide-react';
import { useLanguage } from '../i18n';
import { HelpTip } from './help/HelpTip';
import { ENROLLMENT_MODES, setEnrollmentMode, type EnrollmentMode } from '../services/enrollment.service';

// Toegangsroute van een cursus kiezen (alleen beheerder; server/courses/enrollment.js).
// "Canvas + open" is een uitzondering en vraagt om een extra bevestiging.

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];

export function EnrollmentModeDialog({ courseId, courseName, current, onClose, onSaved }: {
  courseId: string;
  courseName: string;
  current: EnrollmentMode;
  onClose: () => void;
  onSaved: (mode: EnrollmentMode) => void;
}) {
  const { t } = useLanguage();
  const tk = (k: string, v?: Record<string, string>) => t(k as TKey, v);
  const [mode, setMode] = useState<EnrollmentMode>(current);
  const [confirmBoth, setConfirmBoth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      await setEnrollmentMode(courseId, mode, mode === 'canvas_open' && confirmBoth);
      onSaved(mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="title-enrollment-mode" data-testid="dialog-enrollment-mode">
      <div className="chic-card w-full max-w-lg space-y-4 p-6">
        <h3 id="title-enrollment-mode" className="flex items-center gap-2 text-lg font-semibold text-gray-900">
          <DoorOpen className="h-5 w-5 text-blue-600" />{t('enrollment.dialogTitle', { name: courseName })}<HelpTip id="courses.enrollmentMode" />
        </h3>
        <div className="space-y-2" role="radiogroup">
          {ENROLLMENT_MODES.map((m) => (
            <label key={m} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${mode === m ? 'border-blue-400 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'}`}>
              <input type="radio" name="enrollment-mode" className="mt-1" checked={mode === m} onChange={() => { setMode(m); setConfirmBoth(false); }} data-testid={`radio-enrollment-${m}`} />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-gray-900">{tk(`enrollment.mode.${m}`)}</span>
                <span className="block text-xs text-gray-600">{tk(`enrollment.modeDesc.${m}`)}</span>
              </span>
            </label>
          ))}
        </div>
        {mode === 'canvas_open' && (
          <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="box-enrollment-both-warning">
            <p className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{t('enrollment.bothWarning')}</p>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={confirmBoth} onChange={(e) => setConfirmBoth(e.target.checked)} data-testid="checkbox-enrollment-confirm-both" />
              <span>{t('enrollment.bothConfirm')}</span>
            </label>
          </div>
        )}
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-gray-700 hover:bg-gray-100">{t('common.cancelAction')}</button>
          <button
            type="button"
            onClick={save}
            disabled={busy || mode === current || (mode === 'canvas_open' && !confirmBoth)}
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:opacity-40"
            data-testid="button-save-enrollment-mode"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}{t('common.save')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
