import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Trash2, AlertTriangle } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { previewDeleteCourseFiles, type DeletePreview } from '../../services/course-files.service';

// Bevestiging voor het verwijderen van een selectie bestanden/websites
// (server/courseFiles.js: delete-preview en delete). Eerst telt de server wat
// er weggaat; boven BULK_CONFIRM_THRESHOLD bestanden moet de docent de
// cursusnaam typen (de server controleert dat ook).

export function BulkDeleteDialog({ courseId, docIds, webSourceIds, onCancel, onConfirm }: {
  courseId: string;
  docIds: string[];
  webSourceIds: string[];
  onCancel: () => void;
  onConfirm: (confirmName: string) => void;
}) {
  const { t } = useLanguage();
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    let cancelled = false;
    previewDeleteCourseFiles(courseId, { docIds, webSourceIds })
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [courseId, docIds, webSourceIds]);

  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  const nameOk = !preview?.needsName || (!!preview && norm(typed) === norm(preview.courseName));
  const total = preview ? preview.files + preview.webPages : 0;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="title-bulk-delete" data-testid="dialog-bulk-delete">
      <div className="chic-card w-full max-w-lg space-y-4 p-6">
        <h3 id="title-bulk-delete" className="flex items-center gap-2 text-lg font-semibold text-gray-900">
          <Trash2 className="h-5 w-5 text-red-600" />{t('material.bulk.confirmTitle')}
        </h3>
        {!preview && !error && <p className="flex items-center gap-2 text-sm text-gray-600"><Loader2 className="h-4 w-4 animate-spin" />{t('common.loading')}</p>}
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        {preview && (
          <>
            <ul className="list-disc space-y-1 pl-5 text-sm text-gray-800" data-testid="list-bulk-delete-summary">
              {preview.files > 0 && <li>{t('material.bulk.sumFiles', { n: String(preview.files) })}</li>}
              {preview.webSources > 0 && <li>{t('material.bulk.sumWeb', { n: String(preview.webSources), pages: String(preview.webPages) })}</li>}
              <li>{t('material.bulk.sumChunks', { n: String(preview.chunks) })}</li>
              {preview.conceptsLosingEvidence > 0 && <li>{t('material.bulk.sumConcepts', { n: String(preview.conceptsLosingEvidence) })}</li>}
            </ul>
            <p className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{t('material.bulk.irreversible')}
            </p>
            {preview.needsName && (
              <label className="block space-y-1 text-sm">
                <span className="text-gray-700">{t('material.bulk.typeName', { name: preview.courseName })}</span>
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoFocus
                  className="w-full rounded-lg border border-gray-300 px-3 py-2"
                  aria-label={t('material.bulk.typeName', { name: preview.courseName })}
                  data-testid="input-bulk-delete-name"
                />
              </label>
            )}
          </>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg px-4 py-2 text-gray-700 hover:bg-gray-100">{t('common.cancelAction')}</button>
          <button
            type="button"
            disabled={!preview || total + (preview?.webSources || 0) === 0 || !nameOk}
            onClick={() => onConfirm(typed)}
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-red-600 px-4 py-2 font-semibold text-white hover:bg-red-700 disabled:opacity-40"
            data-testid="button-confirm-bulk-delete"
          >
            <Trash2 className="h-4 w-4" />{t('material.bulk.confirm', { n: String(total) })}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
