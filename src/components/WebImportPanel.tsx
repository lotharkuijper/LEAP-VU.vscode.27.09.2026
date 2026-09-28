import { useMemo, useState } from 'react';
import { Globe, Loader2, CheckCircle, AlertTriangle, XCircle, Info, X, Search, Download, Link2 } from 'lucide-react';
import {
  discoverWebPages,
  importWebPages,
  WebImportInterruptedError,
  type DiscoveredPage,
  type WebImportResult,
  type WebImportProgress,
  type WebImportPurpose,
} from '../services/web-import.service';
import { useActiveCourse } from '../contexts/ActiveCourseContext';
import { useLanguage } from '../i18n';
import { AdminHint } from './help/AdminHint';
import { Tooltip } from './help/Tooltip';
import { startTask } from '../lib/backgroundTasks';

type NoticeKind = 'info' | 'warning' | 'error' | 'success';
interface Notice {
  kind: NoticeKind;
  message: string;
}

const NOTICE_STYLES: Record<NoticeKind, { box: string; icon: string }> = {
  info: { box: 'bg-blue-50 border-blue-200 text-blue-900', icon: 'text-blue-600' },
  warning: { box: 'bg-yellow-50 border-yellow-200 text-yellow-900', icon: 'text-yellow-600' },
  error: { box: 'bg-red-50 border-red-200 text-red-900', icon: 'text-red-600' },
  success: { box: 'bg-emerald-50 border-emerald-200 text-emerald-900', icon: 'text-emerald-600' },
};

/**
 * Groepeer ontdekte pagina's per map direct onder de start-URL (bv. alle
 * pagina's onder `/hoofdstuk-3/`), zodat een docent een heel onderdeel in één
 * keer aan of uit kan zetten. Pagina's direct onder de start-URL vallen in ''.
 */
export function groupPagesBySection(pages: DiscoveredPage[], baseUrl: string): Array<{ section: string; pages: DiscoveredPage[] }> {
  let basePath = '/';
  try { basePath = new URL(baseUrl).pathname.replace(/[^/]*$/, ''); } catch { /* ongeldige base: alles in één groep */ }
  const groups = new Map<string, DiscoveredPage[]>();
  for (const p of pages) {
    let section = '';
    try {
      const path = new URL(p.url).pathname;
      const rest = path.startsWith(basePath) ? path.slice(basePath.length) : path.replace(/^\//, '');
      const slash = rest.indexOf('/');
      section = slash > 0 ? rest.slice(0, slash) : '';
    } catch { /* laat in hoofdgroep */ }
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section)!.push(p);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([section, list]) => ({ section, pages: list }));
}

const WEB_PURPOSES: WebImportPurpose[] = ['course_material', 'course_info'];

export function WebImportPanel({
  courseId: courseIdProp,
  embedded = false,
  onImported,
}: {
  /** Doelcursus; standaard de actieve cursus. */
  courseId?: string;
  /** In de werkruimte Cursusmateriaal: zonder uitlegblok en cursus-indicator. */
  embedded?: boolean;
  /** Na een (ook gedeeltelijk) geslaagde import, zodat de lijst ververst. */
  onImported?: (result: WebImportResult | null) => void;
} = {}) {
  const { activeCourseId: contextCourseId, activeCourse } = useActiveCourse();
  const activeCourseId = courseIdProp || contextCourseId;
  const { t } = useLanguage();
  const tk = (k: string) => t(k as Parameters<typeof t>[0]);
  const [purpose, setPurpose] = useState<WebImportPurpose>('course_material');
  const [url, setUrl] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pages, setPages] = useState<DiscoveredPage[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<WebImportResult | null>(null);
  const [progress, setProgress] = useState<WebImportProgress | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const handleDiscover = async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      setNotice({ kind: 'warning', message: t('admin.imports.web.noticeEnterUrl') });
      return;
    }
    setDiscovering(true);
    setResult(null);
    setPages([]);
    setSelected(new Set());
    setNotice({ kind: 'info', message: t('admin.imports.web.noticeDiscovering') });
    try {
      const res = await discoverWebPages(trimmed);
      setPages(res.pages);
      setBaseUrl(res.baseUrl);
      setSelected(new Set(res.pages.map((p) => p.url)));
      if (res.pages.length === 0) {
        setNotice({ kind: 'warning', message: t('admin.imports.web.noticeNoPages') });
      } else {
        const via = res.method === 'sitemap' ? t('admin.imports.web.viaSitemap') : t('admin.imports.web.viaLinks');
        const base = t('admin.imports.web.noticeFound', { count: String(res.pages.length), via });
        setNotice({
          kind: 'success',
          message: base + (res.warnings.length ? ' ' + res.warnings.join(' ') : ''),
        });
      }
    } catch (err) {
      setNotice({
        kind: 'error',
        message: t('admin.imports.web.noticeDiscoverFailed', {
          error: err instanceof Error ? err.message : t('admin.imports.web.unknownError'),
        }),
      });
    }
    setDiscovering(false);
  };

  const toggle = (pageUrl: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pageUrl)) next.delete(pageUrl);
      else next.add(pageUrl);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === pages.length) setSelected(new Set());
    else setSelected(new Set(pages.map((p) => p.url)));
  };

  const sections = useMemo(() => groupPagesBySection(pages, baseUrl), [pages, baseUrl]);

  const toggleSection = (list: DiscoveredPage[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = list.every((p) => next.has(p.url));
      for (const p of list) {
        if (allOn) next.delete(p.url);
        else next.add(p.url);
      }
      return next;
    });
  };

  const handleImport = async () => {
    if (!activeCourseId) {
      setNotice({ kind: 'warning', message: t('admin.imports.web.noticeNoCourse') });
      return;
    }
    const chosen = pages.filter((p) => selected.has(p.url));
    if (chosen.length === 0) {
      setNotice({ kind: 'warning', message: t('admin.imports.web.noticeSelectPage') });
      return;
    }
    setImporting(true);
    setResult(null);
    setProgress(null);
    setNotice({ kind: 'info', message: t('admin.imports.web.noticeImportStarted', { count: String(chosen.length) }) });
    // Als achtergrondtaak: loopt door (en meldt zich in het takenvak) als je
    // intussen naar een ander deel van de app gaat.
    let site = baseUrl;
    try { site = new URL(baseUrl).hostname; } catch { /* laat zoals ingevuld */ }
    await startTask<string>({
      kind: 'web-import',
      key: activeCourseId,
      title: t('tasks.webImport.title', { site }),
      resultLink: '/admin?tab=material&step=files',
      run: async (ctx) => {
        const onProgress = (p: WebImportProgress | null) => {
          setProgress(p);
          ctx.report(p ? { done: p.current, total: p.total, labelKey: 'tasks.web.progress' } : null);
        };
        try {
          const res = await importWebPages(activeCourseId, baseUrl, chosen, onProgress, { purpose });
          setResult(res);
          onImported?.(res);
          const message = t('admin.imports.web.noticeDone', {
            imported: String(res.imported),
            skipped: String(res.skipped),
            errors: String(res.errors),
            chunks: String(res.totalChunks),
          });
          setNotice({ kind: 'success', message });
          return message;
        } catch (err) {
          if (err instanceof WebImportInterruptedError) {
            // De stream is afgekapt (proxy-timeout), maar de tot dan toe verwerkte
            // pagina's zijn opgeslagen. Toon een waarschuwing i.p.v. een harde fout:
            // opnieuw draaien is veilig (ongewijzigde pagina's worden overgeslagen).
            const message = t('admin.imports.web.noticeInterrupted', {
              processed: String(err.processed),
              total: String(err.total),
            });
            setNotice({ kind: 'warning', message });
            onImported?.(null);
            return message;
          }
          const message = t('admin.imports.web.noticeImportFailed', {
            error: err instanceof Error ? err.message : t('admin.imports.web.unknownError'),
          });
          setNotice({ kind: 'error', message });
          throw new Error(message);
        } finally {
          setImporting(false);
          setProgress(null);
        }
      },
      summarize: (message) => message,
    }).promise.catch(() => { /* melding staat al op de pagina en in het takenvak */ });
  };

  const renderNoticeIcon = (kind: NoticeKind, className: string) => {
    if (kind === 'success') return <CheckCircle className={className} />;
    if (kind === 'warning') return <AlertTriangle className={className} />;
    if (kind === 'error') return <XCircle className={className} />;
    return <Info className={className} />;
  };

  return (
    <div className="space-y-6" data-testid="panel-web-import">
      {notice && (
        <div
          className={`flex items-start gap-3 border rounded-lg p-4 ${NOTICE_STYLES[notice.kind].box}`}
          role={notice.kind === 'error' || notice.kind === 'warning' ? 'alert' : 'status'}
          aria-live={notice.kind === 'error' || notice.kind === 'warning' ? 'assertive' : 'polite'}
          data-testid={`notice-web-${notice.kind}`}
        >
          {renderNoticeIcon(notice.kind, `w-5 h-5 mt-0.5 ${NOTICE_STYLES[notice.kind].icon}`)}
          <p className="flex-1 text-sm">{notice.message}</p>
          <Tooltip label={t('admin.imports.web.dismiss')}>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="opacity-70 hover:opacity-100"
              aria-label={t('admin.imports.web.dismiss')}
              data-testid="button-dismiss-web-notice"
            >
              <X className="w-4 h-4" />
            </button>
          </Tooltip>
        </div>
      )}

      {embedded ? (
        <AdminHint variant="intro">{t('admin.imports.web.intro')}</AdminHint>
      ) : (
        <>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <Globe className="w-5 h-5 text-blue-700 mt-0.5" />
              <div className="flex-1">
                <h3 className="font-semibold text-gray-900 mb-1">{t('admin.imports.web.title')}</h3>
                <AdminHint variant="intro">{t('admin.imports.web.intro')}</AdminHint>
              </div>
            </div>
          </div>

          {/* Cursus-indicator */}
          <div className="flex items-start gap-2 text-xs bg-blue-50 border border-blue-200 rounded-lg p-3" data-testid="text-web-active-course">
            <Link2 className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="text-blue-900">
              {activeCourseId && activeCourse
                ? t('admin.imports.web.targetCourse', { course: activeCourse.name })
                : t('admin.imports.web.noCourse')}
            </div>
          </div>
        </>
      )}

      {/* URL-invoer */}
      <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-3">
        <h3 className="font-semibold text-gray-900">{t('admin.imports.web.urlLabel')}</h3>
        <div className="flex gap-2">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !discovering) void handleDiscover(); }}
            placeholder={t('admin.imports.web.urlPlaceholder')}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
            data-testid="input-web-url"
          />
          <button
            onClick={handleDiscover}
            disabled={discovering || !url.trim()}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
            data-testid="button-discover-web"
          >
            {discovering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            {discovering ? t('admin.imports.web.discovering') : t('admin.imports.web.discover')}
          </button>
        </div>
      </div>

      {/* Gevonden pagina's */}
      {pages.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-gray-900">
              {t('admin.imports.web.foundPages')}{' '}
              <span className="text-sm font-normal text-gray-500">
                ({t('admin.imports.web.selectedCount', { selected: String(selected.size), total: String(pages.length) })})
              </span>
            </h3>
            <button
              onClick={toggleAll}
              className="text-sm text-blue-600 hover:text-blue-700 font-medium"
              data-testid="button-toggle-all-web-pages"
            >
              {selected.size === pages.length ? t('admin.imports.web.deselectAll') : t('admin.imports.web.selectAll')}
            </button>
          </div>

          <div className="max-h-96 overflow-y-auto border border-gray-100 rounded-lg mb-6">
            {sections.map(({ section, pages: list }) => {
              const on = list.filter((p) => selected.has(p.url)).length;
              return (
                <div key={section || '__root'} data-testid={`web-section-${section || 'root'}`}>
                  {sections.length > 1 && (
                    <label className="sticky top-0 z-10 flex items-center gap-3 px-3 py-2 bg-gray-50 border-b border-gray-100 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={on === list.length}
                        ref={(el) => { if (el) el.indeterminate = on > 0 && on < list.length; }}
                        onChange={() => toggleSection(list)}
                        className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                        data-testid={`checkbox-web-section-${section || 'root'}`}
                      />
                      <span className="text-sm font-semibold text-gray-800">
                        {section ? `/${section}/` : t('admin.imports.web.sectionRoot')}
                      </span>
                      <span className="text-xs text-gray-500">
                        {t('admin.imports.web.selectedCount', { selected: String(on), total: String(list.length) })}
                      </span>
                    </label>
                  )}
                  <div className="divide-y divide-gray-100">
                    {list.map((p) => (
                      <label
                        key={p.url}
                        className={`flex items-start gap-3 p-3 hover:bg-gray-50 cursor-pointer transition-colors ${sections.length > 1 ? 'pl-8' : ''}`}
                        data-testid={`label-web-page-${p.url}`}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(p.url)}
                          onChange={() => toggle(p.url)}
                          className="w-4 h-4 mt-0.5 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                          data-testid={`checkbox-web-page-${p.url}`}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-gray-800 truncate">{p.title || p.url}</p>
                          <p className="text-xs text-gray-400 truncate">{p.url}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Doel: een website is leerstof of cursusinformatie */}
          <fieldset className="mb-6" data-testid="fieldset-web-purpose">
            <legend className="text-sm font-medium text-gray-800 mb-2">{t('admin.imports.web.purposeQuestion')}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {WEB_PURPOSES.map((p) => (
                <label
                  key={p}
                  className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer ${purpose === p ? 'border-blue-400 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'}`}
                >
                  <input
                    type="radio"
                    name="web-purpose"
                    value={p}
                    checked={purpose === p}
                    onChange={() => setPurpose(p)}
                    className="mt-1"
                    data-testid={`radio-web-purpose-${p}`}
                  />
                  <span>
                    <span className="block text-sm font-medium text-gray-900">{tk(`filePurpose.${p}.label`)}</span>
                    <span className="block text-xs text-gray-600">{tk(`filePurpose.${p}.desc`)}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {importing && progress && (
            <div
              className="mb-6 bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-2"
              role="status"
              aria-live="polite"
              data-testid="web-import-progress"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-medium text-blue-900">
                  <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                  <span>{t('admin.imports.web.progressTitle')}</span>
                </div>
                <span className="text-sm font-semibold text-blue-900 whitespace-nowrap" data-testid="text-web-progress-count">
                  {t('admin.imports.web.progressCount', { current: String(progress.current), total: String(progress.total) })}
                </span>
              </div>
              <div className="h-2 w-full bg-blue-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-600 transition-all duration-300"
                  style={{ width: `${Math.round((progress.current / Math.max(progress.total, 1)) * 100)}%` }}
                  data-testid="bar-web-progress"
                />
              </div>
              <p className="text-xs text-blue-800 truncate" title={progress.url} data-testid="text-web-progress-current">
                {t('admin.imports.web.progressCurrent', { url: progress.title || progress.url })}
              </p>
            </div>
          )}

          <button
            onClick={handleImport}
            disabled={importing || selected.size === 0 || !activeCourseId}
            className="w-full px-6 py-3 bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold rounded-lg hover:from-blue-600 hover:to-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            data-testid="button-import-web-pages"
          >
            {importing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Download className="w-5 h-5" />}
            {importing ? t('admin.imports.web.importing') : t('admin.imports.web.import', { count: String(selected.size) })}
          </button>
        </div>
      )}

      {/* Resultaat */}
      {result && (
        <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-3" data-testid="web-import-result">
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-green-50 border border-green-200 rounded-lg p-4" data-testid="result-web-imported">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle className="w-5 h-5 text-green-600" />
                <span className="text-sm font-medium text-green-900">{t('admin.imports.web.imported')}</span>
              </div>
              <p className="text-2xl font-bold text-green-900">{result.imported}</p>
            </div>
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4" data-testid="result-web-skipped">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-5 h-5 text-yellow-600" />
                <span className="text-sm font-medium text-yellow-900">{t('admin.imports.web.skipped')}</span>
              </div>
              <p className="text-2xl font-bold text-yellow-900">{result.skipped}</p>
            </div>
            <div className="bg-red-50 border border-red-200 rounded-lg p-4" data-testid="result-web-errors">
              <div className="flex items-center gap-2 mb-2">
                <XCircle className="w-5 h-5 text-red-600" />
                <span className="text-sm font-medium text-red-900">{t('admin.imports.web.errors')}</span>
              </div>
              <p className="text-2xl font-bold text-red-900">{result.errors}</p>
            </div>
          </div>

          {result.results.some((r) => r.status !== 'imported') && (
            <div className="text-xs text-gray-600 bg-gray-50 rounded p-3 space-y-1" data-testid="text-web-import-details">
              {result.results.filter((r) => r.status !== 'imported').map((r) => {
                // Ongewijzigde pagina's krijgen een gelokaliseerd label i.p.v. het
                // ruwe server-bericht ('Ongewijzigd'), zodat het in elke UI-taal klopt.
                const detail = r.unchanged
                  ? t('admin.imports.web.statusUnchanged')
                  : r.notFound ? t('admin.imports.web.statusNotFound') : r.message;
                return (
                  <div key={r.url} className="truncate">
                    <span className={r.status === 'error' ? 'text-red-600' : 'text-yellow-700'}>
                      {r.status === 'error' ? t('admin.imports.web.statusError') : t('admin.imports.web.statusSkipped')}
                    </span>{' '}— {r.url}{detail ? ` (${detail})` : ''}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
