import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useLanguage } from '../i18n';
import CursusInfoTab from './CursusInfoTab';

// Cursus-info (tekst, banner en downloads op het Dashboard van studenten) bewerken
// vanuit Cursussen beheren, voor de cursus van die rij.
export function CourseInfoDialog({ courseId, courseName, onClose }: { courseId: string; courseName: string; onClose: () => void }) {
  const { t } = useLanguage();
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={`${t('admin.tabs.courseInfo')}: ${courseName}`} className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl" data-testid="dialog-course-info">
        <div className="mb-3 flex items-center gap-2">
          <p className="min-w-0 flex-1 break-words text-sm font-semibold text-gray-500">{courseName}</p>
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-500 hover:bg-gray-100" aria-label={t('common.close')} data-testid="button-close-course-info"><X className="h-5 w-5" /></button>
        </div>
        <CursusInfoTab courseId={courseId} courseName={courseName} />
      </div>
    </div>,
    document.body,
  );
}
