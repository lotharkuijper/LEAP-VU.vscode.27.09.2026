import { useMemo, useRef, useState } from 'react';
import { Upload, Loader2, Download, Trash2, ArrowRightLeft, X, Globe, AlertTriangle, EyeOff } from 'lucide-react';
import { useLanguage } from '../../i18n';
import {
  uploadCourseFile,
  changePurpose,
  downloadCourseFile,
  deleteCourseFile,
  CourseFilesError,
  type CourseFile,
  type CourseProject,
  type Purpose,
  type WebSource,
} from '../../services/course-files.service';
import { suggestPurpose } from '../../../server/filePurpose.js';
import { PURPOSE_ORDER, PURPOSE_STYLE, formatBytes } from './purposeUi';
import { PurposePicker, type PurposeValue } from './PurposePicker';
import { WebSourceRow } from './WebSourceRow';
import { WebImportPanel } from '../WebImportPanel';
import { HelpTip } from '../help/HelpTip';
import { Tooltip } from '../help/Tooltip';
import { AdminHint } from '../help/AdminHint';

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];

const MAX_RAG_BYTES = 20 * 1024 * 1024;

/** Meest voorkomende voorstel voor een set bestanden (voorselectie bij uploaden). */
export function suggestForBatch(files: Array<{ name: string }>): PurposeValue {
  const counts = new Map<string, { n: number; v: PurposeValue }>();
  for (const f of files) {
    const s = suggestPurpose({ filename: f.name });
    const key = `${s.purpose}:${s.materialKind || ''}`;
    const cur = counts.get(key) || { n: 0, v: { purpose: s.purpose, materialKind: s.materialKind } };
    cur.n++;
    counts.set(key, cur);
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  return best ? best.v : { purpose: 'course_material' };
}

export function FilesStep({
  courseId,
  files,
  projects,
  webSources = [],
  onChanged,
  onGoToProjects,
}: {
  courseId: string;
  files: CourseFile[];
  projects: CourseProject[];
  webSources?: WebSource[];
  onChanged: () => void;
  onGoToProjects: () => void;
}) {
  const { t } = useLanguage();
  const tk = (k: string, v?: Record<string, string>) => t(k as TKey, v);
  const inputRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<File[]>([]);
  const [target, setTarget] = useState<PurposeValue>({ purpose: 'course_material' });
  const [suggested, setSuggested] = useState<Purpose | null>(null);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [moving, setMoving] = useState<CourseFile | null>(null);
  const [moveTo, setMoveTo] = useState<PurposeValue>({ purpose: 'course_material' });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [addingWebsite, setAddingWebsite] = useState(false);

  // Pagina's van een bekende websitebron staan onder die bron, niet als losse rij.
  const sourceIds = useMemo(() => new Set(webSources.map(s => s.id)), [webSources]);
  const byPurpose = useMemo(() => {
    const m = new Map<Purpose, CourseFile[]>();
    for (const p of PURPOSE_ORDER) m.set(p, []);
    for (const f of files) if (!(f.webSourceId && sourceIds.has(f.webSourceId))) m.get(f.purpose)?.push(f);
    return m;
  }, [files, sourceIds]);
  const pagesOf = (id: string) => files.filter(f => f.webSourceId === id);

  const errorText = (err: unknown) => {
    if (err instanceof CourseFilesError && err.code) {
      const key = `filePurpose.error.${err.code}`;
      const translated = tk(key);
      if (translated !== key) return translated;
    }
    return err instanceof Error ? err.message : String(err);
  };

  const addFiles = (list: FileList | File[]) => {
    const arr = [...queue, ...Array.from(list)];
    setQueue(arr);
    const s = suggestForBatch(arr);
    setSuggested(s.purpose);
    setTarget(prev => ({ ...prev, ...s }));
    setNotice(null);
  };

  const doUpload = async () => {
    setUploading(true);
    setNotice(null);
    const errors: string[] = [];
    let ok = 0;
    for (const file of queue) {
      if ((target.purpose === 'course_material' || target.purpose === 'course_info') && file.size > MAX_RAG_BYTES) {
        errors.push(t('material.upload.failed', { name: file.name, error: '> 20 MB' }));
        continue;
      }
      try {
        await uploadCourseFile(courseId, file, target);
        ok++;
      } catch (err) {
        errors.push(t('material.upload.failed', { name: file.name, error: errorText(err) }));
      }
    }
    setUploading(false);
    setQueue([]);
    setSuggested(null);
    const next = ok && target.purpose === 'course_material' ? ` ${t('material.upload.nextConcepts')}` : '';
    setNotice(errors.length
      ? { kind: 'error', text: [ok ? t('material.upload.done', { n: String(ok) }) + next : '', ...errors].filter(Boolean).join(' · ') }
      : { kind: 'ok', text: t('material.upload.done', { n: String(ok) }) + next });
    onChanged();
  };

  const openMove = (f: CourseFile) => {
    setMoving(f);
    setMoveTo({ purpose: f.purpose });
  };

  const doMove = async () => {
    if (!moving) return;
    setBusyId(moving.id);
    try {
      const r = await changePurpose(courseId, moving.id, moveTo);
      setNotice({
        kind: 'ok',
        text: `${t('material.files.moved', { name: moving.title, purpose: tk(`filePurpose.${r.purpose}.label`) })}${r.reprocessing ? ` ${t('material.files.reprocessing')}` : ''}`,
      });
      setMoving(null);
      onChanged();
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err) });
    } finally {
      setBusyId(null);
    }
  };

  const doDelete = async (f: CourseFile) => {
    setBusyId(f.id);
    try {
      await deleteCourseFile(f.id);
      setConfirmDelete(null);
      onChanged();
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err) });
    } finally {
      setBusyId(null);
    }
  };

  const statusBadge = (f: CourseFile) => {
    if (f.processing_status === 'processing' || f.processing_status === 'pending') {
      return <span className="inline-flex items-center gap-1 text-xs text-sky-700"><Loader2 className="w-3 h-3 animate-spin" />{t('material.files.status.processing')}</span>;
    }
    if (f.processing_status === 'failed') {
      return <span className="inline-flex items-center gap-1 text-xs text-red-700"><AlertTriangle className="w-3 h-3" />{t('material.files.status.failed')}</span>;
    }
    if ((f.purpose === 'course_material' || f.purpose === 'course_info') && f.total_chunks) {
      return <span className="text-xs text-gray-500">{t('material.files.chunks', { n: String(f.total_chunks) })}</span>;
    }
    return null;
  };

  return (
    <div className="space-y-6">
      {/* Uploaden met doel */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-4" data-testid="panel-upload">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-gray-900">{t('material.upload.title')}</h3>
          <span className="inline-flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setAddingWebsite(true)}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-medium border border-sky-300 text-sky-800 bg-white hover:bg-sky-50"
              data-testid="button-add-website"
            >
              <Globe className="w-4 h-4" />
              {t('material.web.add')}
            </button>
            <HelpTip id="material.addWebsite" />
          </span>
        </div>
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files); }}
          className={`cursor-pointer rounded-xl border-2 border-dashed px-4 py-6 text-center text-sm transition-colors ${dragOver ? 'border-sky-400 bg-sky-50' : 'border-gray-300 hover:border-sky-300 bg-gray-50'}`}
          data-testid="dropzone-course-files"
        >
          <Upload className="w-6 h-6 mx-auto mb-2 text-sky-500" />
          {t('material.upload.dropzone')}
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={e => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ''; }}
            data-testid="input-course-files"
          />
        </div>

        {queue.length > 0 && (
          <div className="space-y-4">
            <ul className="flex flex-wrap gap-2">
              {queue.map((f, i) => (
                <li key={`${f.name}-${i}`} className="inline-flex items-center gap-1 text-xs bg-gray-100 rounded-full pl-3 pr-1 py-1">
                  {f.name}
                  <Tooltip label={t('material.upload.remove')}>
                    <button type="button" onClick={() => setQueue(q => q.filter((_, j) => j !== i))} className="p-0.5 rounded-full hover:bg-gray-200">
                      <X className="w-3 h-3" />
                    </button>
                  </Tooltip>
                </li>
              ))}
            </ul>
            <div>
              <p className="text-sm font-medium text-gray-800 mb-2 flex items-center gap-1.5">{t('material.upload.purposeQuestion')}<HelpTip id="material.purposes" /></p>
              <PurposePicker value={target} onChange={setTarget} projects={projects} suggested={suggested} idPrefix="upload-purpose" />
            </div>
            {(target.purpose === 'course_material' || target.purpose === 'course_info') && (
              <AdminHint variant="tip">{t('material.upload.ragTypesHint')}</AdminHint>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={doUpload}
                disabled={uploading || (target.purpose === 'project' && !target.projectId)}
                className="btn-primary px-4 py-2 rounded-xl text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
                data-testid="button-upload-course-files"
              >
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                {uploading ? t('material.upload.uploading') : t('material.upload.uploadBtn', { n: String(queue.length) })}
              </button>
              {!uploading && (
                <button type="button" onClick={() => { setQueue([]); setSuggested(null); }} className="text-sm text-gray-600 hover:text-gray-900 px-2">
                  {t('material.upload.clear')}
                </button>
              )}
            </div>
          </div>
        )}
        {notice && (
          <p className={`text-sm rounded-lg px-3 py-2 ${notice.kind === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`} data-testid="text-files-notice">
            {notice.text}
          </p>
        )}
      </section>

      {/* Bestanden per doel */}
      {PURPOSE_ORDER.map(p => {
        const s = PURPOSE_STYLE[p];
        const Icon = s.icon;
        const list = byPurpose.get(p) || [];
        const sources = webSources.filter(w => w.purpose === p);
        const projectDocCount = p === 'project' ? projects.reduce((n, pr) => n + pr.documents.length, 0) : 0;
        return (
          <section key={p} className={`rounded-2xl border ${s.ring} bg-white`} data-testid={`section-purpose-${p}`}>
            <header className="flex flex-wrap items-start gap-3 px-5 py-3 border-b border-gray-100">
              <span className={`inline-flex items-center justify-center w-8 h-8 rounded-lg border ${s.chip}`}><Icon className="w-4 h-4" /></span>
              <div className="flex-1 min-w-[12rem]">
                <h3 className="font-semibold text-gray-900">
                  {tk(`filePurpose.${p}.label`)}{' '}
                  <span className="text-xs font-normal text-gray-500">{t('material.files.count', { n: String(list.length + projectDocCount) })}</span>
                  {sources.length > 0 && (
                    <span className="text-xs font-normal text-gray-500"> · {t('material.web.count', { n: String(sources.length) })}</span>
                  )}
                </h3>
                <AdminHint variant="intro">{tk(`filePurpose.${p}.desc`)}</AdminHint>
              </div>
            </header>

            {p === 'project' && (
              <div className="px-5 py-3 space-y-3">
                {projects.length === 0 && <p className="text-sm text-gray-500">{t('material.files.noProjects')}</p>}
                {projects.map(pr => (
                  <div key={pr.id} className="rounded-lg bg-gray-50 px-3 py-2" data-testid={`project-files-${pr.id}`}>
                    <div className="flex items-center justify-between text-sm font-medium text-gray-800">
                      {pr.title}
                      <button type="button" onClick={onGoToProjects} className="text-xs text-sky-700 hover:underline">{t('material.files.manageInProjects')}</button>
                    </div>
                    {pr.documents.length === 0 ? (
                      <p className="text-xs text-gray-500">{t('material.files.empty')}</p>
                    ) : (
                      <ul className="mt-1 space-y-0.5">
                        {pr.documents.map(d => (
                          <li key={d.id} className="text-xs text-gray-700 flex flex-wrap items-center gap-2">
                            <span>{d.filename}</span>
                            {d.material_kind && <span className="px-1.5 rounded bg-emerald-100 text-emerald-800">{tk(`filePurpose.kind.${d.material_kind}`)}</span>}
                            {!d.is_visible_to_students && <span className="inline-flex items-center gap-0.5 text-gray-500"><EyeOff className="w-3 h-3" />{t('material.files.hiddenForStudents')}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}

            {sources.length > 0 && (
              <ul className="divide-y divide-gray-100 border-b border-gray-100" data-testid={`list-web-sources-${p}`}>
                {sources.map(src => (
                  <WebSourceRow key={src.id} courseId={courseId} source={src} pages={pagesOf(src.id)} onChanged={onChanged} />
                ))}
              </ul>
            )}

            {list.length === 0 && sources.length === 0 && p !== 'project' ? (
              <p className="px-5 py-3 text-sm text-gray-500">{t('material.files.empty')}</p>
            ) : list.length > 0 && (
              <ul className="divide-y divide-gray-100">
                {list.map(f => (
                  <li key={f.id} className="px-5 py-2.5 flex flex-wrap items-center gap-3" data-testid={`row-file-${f.id}`}>
                    <div className="flex-1 min-w-[12rem]">
                      <div className="text-sm font-medium text-gray-900 flex items-center gap-2">
                        {f.isWeb && <Globe className="w-3.5 h-3.5 text-gray-400" />}
                        {f.title}
                        {!f.purposeConfirmed && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-fuchsia-100 text-fuchsia-700">{t('material.files.unconfirmed')}</span>}
                      </div>
                      <div className="text-xs text-gray-500 flex flex-wrap gap-2">
                        {f.isWeb ? t('material.files.web') : (f.file_type || '').toUpperCase()}
                        {f.file_size ? <span>{formatBytes(f.file_size)}</span> : null}
                        {statusBadge(f)}
                      </div>
                    </div>
                    {confirmDelete === f.id ? (
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-red-700">{t('material.files.deleteConfirm', { name: f.title })}</span>
                        <button type="button" onClick={() => doDelete(f)} disabled={busyId === f.id} className="px-2 py-1 rounded bg-red-600 text-white" data-testid={`button-confirm-delete-file-${f.id}`}>
                          {busyId === f.id ? <Loader2 className="w-3 h-3 animate-spin" /> : t('material.files.delete')}
                        </button>
                        <button type="button" onClick={() => setConfirmDelete(null)} className="px-2 py-1 rounded bg-gray-200">{t('material.files.cancel')}</button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        <button type="button" onClick={() => openMove(f)} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-gray-200 hover:bg-gray-50" data-testid={`button-change-purpose-${f.id}`}>
                          <ArrowRightLeft className="w-3.5 h-3.5" />{t('material.files.changePurpose')}
                        </button>
                        {!f.isWeb && (
                          <Tooltip label={t('material.files.download')}>
                            <button type="button" onClick={() => downloadCourseFile(f.id, f.filename || f.title).catch(err => setNotice({ kind: 'error', text: errorText(err) }))} className="p-1.5 rounded-lg hover:bg-gray-100">
                              <Download className="w-4 h-4 text-gray-600" />
                            </button>
                          </Tooltip>
                        )}
                        <Tooltip label={t('material.files.delete')}>
                          <button type="button" onClick={() => setConfirmDelete(f.id)} className="p-1.5 rounded-lg hover:bg-red-50" data-testid={`button-delete-file-${f.id}`}>
                            <Trash2 className="w-4 h-4 text-red-600" />
                          </button>
                        </Tooltip>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}

      {/* Website toevoegen */}
      {addingWebsite && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-4 overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="title-add-website" data-testid="dialog-add-website">
          <div className="chic-card max-w-3xl w-full p-6 space-y-4 my-8">
            <div className="flex items-start justify-between gap-3">
              <h3 id="title-add-website" className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <Globe className="w-5 h-5 text-sky-600" />{t('material.web.addTitle')}
              </h3>
              <Tooltip label={t('material.files.cancel')} side="bottom">
                <button type="button" onClick={() => setAddingWebsite(false)} className="p-1 rounded-lg hover:bg-gray-100" data-testid="button-close-add-website">
                  <X className="w-5 h-5" />
                </button>
              </Tooltip>
            </div>
            <WebImportPanel courseId={courseId} embedded onImported={() => onChanged()} />
          </div>
        </div>
      )}

      {/* Doel wijzigen */}
      {moving && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true" data-testid="dialog-change-purpose">
          <div className="chic-card max-w-3xl w-full p-6 space-y-4">
            <h3 className="text-lg font-semibold text-gray-900">{t('material.files.moveTitle', { name: moving.title })}</h3>
            <PurposePicker value={moveTo} onChange={setMoveTo} projects={projects} suggested={moving.suggestion?.purpose} idPrefix="move-purpose" />
            <p className="text-xs text-gray-500">{t('material.files.moveNote')}</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setMoving(null)} className="px-4 py-2 rounded-xl text-sm bg-gray-100 hover:bg-gray-200">{t('material.files.cancel')}</button>
              <button
                type="button"
                onClick={doMove}
                disabled={busyId === moving.id || (moveTo.purpose === 'project' && !moveTo.projectId)}
                className="btn-primary px-4 py-2 rounded-xl text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
                data-testid="button-apply-purpose"
              >
                {busyId === moving.id && <Loader2 className="w-4 h-4 animate-spin" />}
                {t('material.files.moveApply')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
