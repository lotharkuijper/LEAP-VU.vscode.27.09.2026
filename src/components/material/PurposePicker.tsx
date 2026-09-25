import { useLanguage } from '../../i18n';
import type { Purpose, MaterialKind, CourseProject } from '../../services/course-files.service';
import { PURPOSE_ORDER, PURPOSE_STYLE, MATERIAL_KIND_ORDER } from './purposeUi';

export interface PurposeValue {
  purpose: Purpose;
  projectId?: string;
  materialKind?: MaterialKind;
}

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];

/** Keuzekaarten per doel, met uitleg wat LEAP ermee doet; bij Projectmateriaal ook project + soort. */
export function PurposePicker({
  value,
  onChange,
  projects,
  suggested,
  idPrefix = 'purpose',
  exclude = [],
}: {
  value: PurposeValue;
  onChange: (v: PurposeValue) => void;
  projects: CourseProject[];
  suggested?: Purpose | null;
  idPrefix?: string;
  exclude?: Purpose[];
}) {
  const { t } = useLanguage();
  const tk = (k: string, v?: Record<string, string>) => t(k as TKey, v);
  return (
    <div className="space-y-2" role="radiogroup">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {PURPOSE_ORDER.filter(p => !exclude.includes(p)).map(p => {
          const s = PURPOSE_STYLE[p];
          const Icon = s.icon;
          const active = value.purpose === p;
          return (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange({ ...value, purpose: p })}
              className={`text-left rounded-xl border p-3 transition-all ${active ? `${s.chip} ring-2 ring-offset-1 ring-sky-400` : 'bg-white border-gray-200 hover:border-gray-300'}`}
              data-testid={`${idPrefix}-option-${p}`}
            >
              <div className="flex items-center gap-2 font-semibold text-sm text-gray-900">
                <Icon className="w-4 h-4" />
                {tk(`filePurpose.${p}.label`)}
                {suggested === p && (
                  <span className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-fuchsia-100 text-fuchsia-700">
                    {t('material.upload.suggested')}
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-600 mt-1">{tk(`filePurpose.${p}.short`)}</p>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-gray-600" data-testid={`${idPrefix}-desc`}>{tk(`filePurpose.${value.purpose}.desc`)}</p>
      {value.purpose === 'project' && (
        projects.length === 0 ? (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{t('material.upload.noProjects')}</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            <label className="text-xs text-gray-700 flex flex-col gap-1">
              {t('material.upload.project')}
              <select
                value={value.projectId || ''}
                onChange={e => onChange({ ...value, projectId: e.target.value || undefined })}
                className="chic-input text-sm px-2 py-1.5"
                data-testid={`${idPrefix}-select-project`}
              >
                <option value="">{t('material.upload.chooseProject')}</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>
            </label>
            <label className="text-xs text-gray-700 flex flex-col gap-1">
              {t('material.upload.kind')}
              <select
                value={value.materialKind || 'assignment'}
                onChange={e => onChange({ ...value, materialKind: e.target.value as MaterialKind })}
                className="chic-input text-sm px-2 py-1.5"
                data-testid={`${idPrefix}-select-kind`}
              >
                {MATERIAL_KIND_ORDER.map(k => <option key={k} value={k}>{tk(`filePurpose.kind.${k}`)}</option>)}
              </select>
            </label>
          </div>
        )
      )}
    </div>
  );
}

/** Compacte keuzelijst (voor tabellen zoals de eenmalige controle). */
export function PurposeSelect({
  value,
  onChange,
  projects,
  testId,
}: {
  value: PurposeValue;
  onChange: (v: PurposeValue) => void;
  projects: CourseProject[];
  testId: string;
}) {
  const { t } = useLanguage();
  const tk = (k: string) => t(k as TKey);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={value.purpose}
        onChange={e => onChange({ ...value, purpose: e.target.value as Purpose })}
        className="chic-input text-sm px-2 py-1"
        data-testid={testId}
      >
        {PURPOSE_ORDER.map(p => <option key={p} value={p}>{tk(`filePurpose.${p}.label`)}</option>)}
      </select>
      {value.purpose === 'project' && (
        <select
          value={value.projectId || ''}
          onChange={e => onChange({ ...value, projectId: e.target.value || undefined })}
          className="chic-input text-sm px-2 py-1"
          data-testid={`${testId}-project`}
        >
          <option value="">{t('material.upload.chooseProject')}</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
      )}
    </div>
  );
}
