import { useState } from 'react';
import { Loader2, Plus, Trash2, X } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { saveImageFeatures, type ImageExercise, type ImageFeature } from '../../services/image-exercises.service';

/** De kenmerkenlijst van één foto aanpassen. Opslaan maakt de lijst "nagelopen". */
export function ImageFeatureEditor({ courseId, exercise, onClose, onSaved }: {
  courseId: string;
  exercise: ImageExercise;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLanguage();
  const [list, setList] = useState<ImageFeature[]>(() => exercise.features.map((f) => ({ ...f })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (i: number, patch: Partial<ImageFeature>) => setList((l) => l.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const add = () => setList((l) => [...l, { label: '', observation: '', interpretation: '', is_core: true, open_interpretation: false }]);
  const remove = (i: number) => setList((l) => l.filter((_, j) => j !== i));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveImageFeatures(courseId, exercise.id, list.filter((f) => f.label.trim()));
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const input = 'w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:border-sky-400 focus:outline-none';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="title-feature-editor" data-testid="dialog-feature-editor">
      <div className="chic-card my-8 w-full max-w-3xl space-y-4 p-6">
        <div className="flex items-start justify-between gap-3">
          <h3 id="title-feature-editor" className="text-lg font-semibold text-gray-900">{t('imageEx.editor.title', { name: exercise.filename })}</h3>
          <button type="button" onClick={onClose} className="rounded-lg p-1 hover:bg-gray-100" aria-label={t('imageEx.cancel')}><X className="h-5 w-5" /></button>
        </div>
        <p className="text-sm text-gray-600">{t('imageEx.editor.intro')}</p>
        <ol className="space-y-3">
          {list.map((f, i) => (
            <li key={f.id || `new-${i}`} className="space-y-2 rounded-xl border border-gray-200 p-3" data-testid={`editor-feature-${i}`}>
              <div className="flex flex-wrap items-center gap-2">
                <input className={`${input} min-w-[12rem] flex-1 font-medium`} value={f.label} maxLength={120} onChange={(e) => set(i, { label: e.target.value })} placeholder={t('imageEx.editor.label')} aria-label={t('imageEx.editor.label')} />
                <button type="button" onClick={() => set(i, { is_core: !f.is_core })} className={`rounded-full px-3 py-1 text-xs font-semibold ${f.is_core ? 'bg-brand-600 text-white' : 'border border-gray-300 text-gray-700'}`} data-testid={`editor-core-${i}`}>
                  {f.is_core ? t('imageEx.core') : t('imageEx.extra')}
                </button>
                <button type="button" onClick={() => remove(i)} className="rounded-lg p-1.5 hover:bg-red-50" aria-label={t('imageEx.editor.remove')}><Trash2 className="h-4 w-4 text-red-600" /></button>
              </div>
              <textarea className={input} rows={2} value={f.observation} maxLength={600} onChange={(e) => set(i, { observation: e.target.value })} placeholder={t('imageEx.editor.observation')} aria-label={t('imageEx.editor.observation')} />
              <textarea className={input} rows={2} value={f.interpretation} maxLength={600} onChange={(e) => set(i, { interpretation: e.target.value })} placeholder={t('imageEx.editor.interpretation')} aria-label={t('imageEx.editor.interpretation')} />
              <label className="flex items-center gap-2 text-xs text-gray-700">
                <input type="checkbox" checked={f.open_interpretation} onChange={(e) => set(i, { open_interpretation: e.target.checked })} />
                {t('imageEx.editor.open')}
              </label>
            </li>
          ))}
        </ol>
        <button type="button" onClick={add} className="inline-flex items-center gap-1.5 text-sm text-sky-700 hover:underline" data-testid="button-editor-add"><Plus className="h-4 w-4" />{t('imageEx.editor.add')}</button>
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl bg-gray-100 px-4 py-2 text-sm hover:bg-gray-200">{t('imageEx.cancel')}</button>
          <button type="button" onClick={save} disabled={busy || !list.some((f) => f.label.trim())} className="btn-primary inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-50" data-testid="button-editor-save">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}{t('imageEx.editor.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
