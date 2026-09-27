import { useState } from 'react';
import { Globe, ChevronDown, ChevronRight, RefreshCw, Loader2, Trash2, AlertTriangle, ExternalLink } from 'lucide-react';
import { useLanguage } from '../../i18n';
import {
  changeWebSourcePurpose,
  deleteWebSource,
  deleteCourseFile,
  type CourseFile,
  type WebSource,
} from '../../services/course-files.service';
import { importWebPages, WebImportInterruptedError, type WebImportProgress } from '../../services/web-import.service';
import { HelpTip } from '../help/HelpTip';

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];
type WebPurpose = WebSource['purpose'];

/**
 * Eén website als één bron in de bestandenlijst: samenvatting, opnieuw ophalen,
 * doel voor de hele site wijzigen, verwijderen, en openklappen naar de pagina's.
 */
export function WebSourceRow({
  courseId,
  source,
  pages,
  onChanged,
}: {
  courseId: string;
  source: WebSource;
  pages: CourseFile[];
  onChanged: () => void;
}) {
  const { t } = useLanguage();
  const tk = (k: string, v?: Record<string, string>) => t(k as TKey, v);
  const [open, setOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<WebImportProgress | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const [pendingPurpose, setPendingPurpose] = useState<WebPurpose | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmPage, setConfirmPage] = useState<string | null>(null);

  const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const otherPurpose: WebPurpose = source.purpose === 'course_material' ? 'course_info' : 'course_material';
  const last = source.lastSync;
  const problems = (last?.errors || 0) > 0;

  const resync = async () => {
    setSyncing(true);
    setNotice(null);
    setProgress(null);
    try {
      const res = await importWebPages(courseId, source.baseUrl, [], setProgress, { webSourceId: source.id, resync: true });
      const s = res.summary;
      const text = s
        ? t('material.web.syncDone', {
          imported: String(s.imported), unchanged: String(s.unchanged), errors: String(s.errors),
        }) + (s.notFound ? ` ${t('material.web.syncNotFound', { n: String(s.notFound) })}` : '')
        : t('material.web.syncDoneShort');
      setNotice({ kind: s && s.errors ? 'warn' : 'ok', text });
    } catch (err) {
      if (err instanceof WebImportInterruptedError) {
        setNotice({ kind: 'warn', text: t('admin.imports.web.noticeInterrupted', { processed: String(err.processed), total: String(err.total) }) });
      } else {
        setNotice({ kind: 'error', text: errText(err) });
      }
    } finally {
      setSyncing(false);
      setProgress(null);
      onChanged();
    }
  };

  const applyPurpose = async () => {
    if (!pendingPurpose) return;
    setBusy(true);
    try {
      await changeWebSourcePurpose(courseId, source.id, pendingPurpose);
      setPendingPurpose(null);
      onChanged();
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteWebSource(courseId, source.id);
      onChanged();
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err) });
      setBusy(false);
    }
  };

  const removePage = async (id: string) => {
    setBusy(true);
    try {
      await deleteCourseFile(id);
      setConfirmPage(null);
      onChanged();
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="px-5 py-3 space-y-2" data-testid={`row-web-source-${source.id}`}>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="flex-1 min-w-[12rem] text-left"
          aria-expanded={open}
          data-testid={`button-toggle-web-source-${source.id}`}
        >
          <div className="text-sm font-medium text-gray-900 flex items-center gap-2">
            {open ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
            <Globe className="w-4 h-4 text-sky-600" />
            {source.title}
            {problems && (
              <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800" data-testid={`badge-web-problems-${source.id}`}>
                <AlertTriangle className="w-3 h-3" />{t('material.web.problems', { n: String(last?.errors || 0) })}
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500 flex flex-wrap gap-2 pl-10">
            <span>{t('material.web.pages', { n: String(source.pageCount) })}</span>
            <span>{t('material.files.chunks', { n: String(source.chunkCount) })}</span>
            <span>
              {source.lastSyncedAt
                ? t('material.web.lastSynced', { date: new Date(source.lastSyncedAt).toLocaleDateString() })
                : t('material.web.neverSynced')}
            </span>
          </div>
        </button>

        {confirmDelete ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-red-700">{t('material.web.deleteConfirm', { name: source.title, n: String(source.pageCount) })}</span>
            <button type="button" onClick={remove} disabled={busy} className="px-2 py-1 rounded bg-red-600 text-white" data-testid={`button-confirm-delete-web-source-${source.id}`}>
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : t('material.files.delete')}
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} className="px-2 py-1 rounded bg-gray-200">{t('material.files.cancel')}</button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={resync}
              disabled={syncing || busy}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-sky-200 text-sky-800 hover:bg-sky-50 disabled:opacity-50"
              data-testid={`button-resync-web-source-${source.id}`}
            >
              {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              {syncing ? t('material.web.syncing') : t('material.web.resync')}
            </button>
            <HelpTip id="material.web.resync" />
            <button
              type="button"
              onClick={() => setPendingPurpose(otherPurpose)}
              disabled={syncing || busy}
              className="text-xs px-2 py-1 rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-50"
              data-testid={`button-web-source-purpose-${source.id}`}
            >
              {t('material.web.makePurpose', { purpose: tk(`filePurpose.${otherPurpose}.label`) })}
            </button>
            <button type="button" onClick={() => setConfirmDelete(true)} disabled={syncing} className="p-1.5 rounded-lg hover:bg-red-50" title={t('material.files.delete')} aria-label={t('material.files.delete')} data-testid={`button-delete-web-source-${source.id}`}>
              <Trash2 className="w-4 h-4 text-red-600" />
            </button>
          </div>
        )}
      </div>

      {pendingPurpose && (
        <div className="ml-10 flex flex-wrap items-center gap-2 text-xs rounded-lg bg-gray-50 px-3 py-2" data-testid={`confirm-web-source-purpose-${source.id}`}>
          <span className="text-gray-800">
            {t('material.web.purposeConfirm', { n: String(source.pageCount), purpose: tk(`filePurpose.${pendingPurpose}.label`) })}
            {pendingPurpose === 'course_info' && ` ${t('material.web.purposeInfoNote')}`}
          </span>
          <button type="button" onClick={applyPurpose} disabled={busy} className="px-2 py-1 rounded bg-sky-600 text-white" data-testid={`button-apply-web-source-purpose-${source.id}`}>
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : t('material.files.moveApply')}
          </button>
          <button type="button" onClick={() => setPendingPurpose(null)} className="px-2 py-1 rounded bg-gray-200">{t('material.files.cancel')}</button>
        </div>
      )}

      {syncing && progress && (
        <p className="ml-10 text-xs text-sky-800 truncate" role="status" data-testid={`text-web-source-progress-${source.id}`}>
          {t('admin.imports.web.progressCount', { current: String(progress.current), total: String(progress.total) })} — {progress.title || progress.url}
        </p>
      )}

      {notice && (
        <p
          className={`ml-10 text-xs rounded-lg px-3 py-2 ${notice.kind === 'ok' ? 'bg-emerald-50 text-emerald-800' : notice.kind === 'warn' ? 'bg-amber-50 text-amber-900' : 'bg-red-50 text-red-800'}`}
          data-testid={`text-web-source-notice-${source.id}`}
        >
          {notice.text}
        </p>
      )}

      {open && (
        <ul className="ml-10 divide-y divide-gray-100 border border-gray-100 rounded-lg" data-testid={`list-web-pages-${source.id}`}>
          {pages.length === 0 && <li className="px-3 py-2 text-xs text-gray-500">{t('material.web.noPages')}</li>}
          {pages.map(p => (
            <li key={p.id} className="px-3 py-2 flex flex-wrap items-center gap-2 text-xs">
              <div className="flex-1 min-w-[10rem]">
                <p className="text-gray-900 truncate">{p.title}</p>
                {p.url && (
                  <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-sky-700 inline-flex items-center gap-1 truncate max-w-full">
                    {p.url}<ExternalLink className="w-3 h-3 flex-shrink-0" />
                  </a>
                )}
              </div>
              {p.processing_status === 'failed'
                ? <span className="text-red-700">{t('material.files.status.failed')}</span>
                : <span className="text-gray-500">{t('material.files.chunks', { n: String(p.total_chunks || 0) })}</span>}
              {confirmPage === p.id ? (
                <>
                  <button type="button" onClick={() => removePage(p.id)} disabled={busy} className="px-2 py-0.5 rounded bg-red-600 text-white">{t('material.files.delete')}</button>
                  <button type="button" onClick={() => setConfirmPage(null)} className="px-2 py-0.5 rounded bg-gray-200">{t('material.files.cancel')}</button>
                </>
              ) : (
                <button type="button" onClick={() => setConfirmPage(p.id)} className="p-1 rounded hover:bg-red-50" title={t('material.files.delete')} aria-label={t('material.files.delete')}>
                  <Trash2 className="w-3.5 h-3.5 text-red-600" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
