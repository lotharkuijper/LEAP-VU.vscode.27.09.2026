import { SlidersHorizontal } from 'lucide-react';
import { useLanguage } from '../../i18n';
import type { CourseFile } from '../../services/course-files.service';
import type { ExtractionOptions } from '../../lib/conceptExtractionJob';

/**
 * "Meer opties" bij het extraheren van begrippen: taal van de begrippen en
 * welke documenten gelezen worden (leeg = alle verwerkte leerstof). Geldt voor
 * "Zoek nieuwe begrippen" én "Hergenereer begrippenlijst". Overgenomen uit de
 * vroegere klassieke weergave (RAG Beheer).
 */
export function ExtractionOptionsPanel({ files, value, onChange }: {
  files: CourseFile[];
  value: ExtractionOptions;
  onChange: (next: ExtractionOptions) => void;
}) {
  const { t } = useLanguage();
  const docs = files.filter(f => f.purpose === 'course_material' && f.processing_status === 'completed');
  const selected = new Set(value.documentIds.filter(id => docs.some(d => d.id === id)));
  const all = selected.size === 0;

  const toggleDoc = (id: string) => {
    const next = new Set(all ? docs.map(d => d.id) : selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    // Alles aangevinkt (of niets) = gewoon de hele cursus.
    onChange({ ...value, documentIds: next.size === 0 || next.size === docs.length ? [] : [...next] });
  };

  return (
    <details className="rounded-xl border border-gray-200 bg-white" data-testid="panel-extraction-options">
      <summary className="flex cursor-pointer items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700">
        <SlidersHorizontal className="h-4 w-4 text-gray-500" aria-hidden />
        {t('material.extractOptions.title')}
        {(!all || value.language !== 'auto') && (
          <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-800" data-testid="badge-extraction-options-active">
            {t('material.extractOptions.active')}
          </span>
        )}
      </summary>
      <div className="space-y-4 border-t border-gray-100 px-4 py-3">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">{t('material.extractOptions.language')}</span>
          <select
            value={value.language}
            onChange={e => onChange({ ...value, language: e.target.value as ExtractionOptions['language'] })}
            className="w-full max-w-xs rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
            data-testid="select-extraction-language"
          >
            <option value="auto">{t('material.extractOptions.langAuto')}</option>
            <option value="nl">{t('material.extractOptions.langNl')}</option>
            <option value="en">{t('material.extractOptions.langEn')}</option>
          </select>
        </label>

        <div className="text-sm">
          <p className="mb-1 font-medium text-gray-700">{t('material.extractOptions.documents')}</p>
          {docs.length === 0 ? (
            <p className="text-gray-500">{t('material.extractOptions.noDocuments')}</p>
          ) : (
            <>
              <label className="flex items-center gap-2 py-0.5">
                <input
                  type="checkbox"
                  checked={all}
                  onChange={() => onChange({ ...value, documentIds: [] })}
                  data-testid="checkbox-extract-all-documents"
                />
                <span>{t('material.extractOptions.allDocuments', { n: String(docs.length) })}</span>
              </label>
              <ul className="ml-6 max-h-56 space-y-0.5 overflow-y-auto">
                {docs.map(d => (
                  <li key={d.id}>
                    <label className="flex min-w-0 items-center gap-2 py-0.5">
                      <input
                        type="checkbox"
                        checked={all || selected.has(d.id)}
                        onChange={() => toggleDoc(d.id)}
                        data-testid={`checkbox-extract-doc-${d.id}`}
                      />
                      <span className="min-w-0 truncate text-gray-700">{d.title || d.filename}</span>
                    </label>
                  </li>
                ))}
              </ul>
              {!all && <p className="mt-2 text-xs text-amber-800">{t('material.extractOptions.selectionHint')}</p>}
            </>
          )}
        </div>
      </div>
    </details>
  );
}
