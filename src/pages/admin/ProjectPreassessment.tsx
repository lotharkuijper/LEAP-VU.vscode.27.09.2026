import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X, FileDown, RefreshCw, Archive } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { AdminHint } from '../../components/help/AdminHint';
import { HelpTip } from '../../components/help/HelpTip';
import { Tooltip } from '../../components/help/Tooltip';
import { StatusBadge } from '../../components/ui/ListRow';

// Voorbeoordeling van het ingeleverde eindproduct (server/preassessment.js).
// Alleen voor docenten van de cursus: een Beoordelaar aanwijzen, per
// inlevering de voorbeoordeling bekijken of als Word downloaden, en alles in
// één zip. Studenten zien alleen dát er een voorbeoordeling voor de docent is.

export type Indication = 'strong' | 'adequate' | 'weak' | 'unclear';
export interface PreassessmentContent {
  summary: string;
  criteria: Array<{ criterion: string; indication: Indication; strengths: string[]; concerns: string[]; quotes: string[] }>;
  attention: string[];
  parts?: number;
  truncated?: boolean;
  rubricFiles?: string[];
}
export interface Preassessment {
  submissionId: string;
  status: 'pending' | 'done' | 'failed';
  content: PreassessmentContent | null;
  error: string | null;
  updatedAt: string;
}

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];

async function downloadBlob(url: string, token: string, fallbackName: string) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || '');
  const cd = r.headers.get('Content-Disposition') || '';
  const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  const blob = await r.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** Voorbeoordelingen van een project; ververst vanzelf zolang er één bezig is. */
export function usePreassessments(projectId: string, token: string, enabled: boolean) {
  const [byId, setById] = useState<Record<string, Preassessment>>({});
  const [personaId, setPersonaId] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const r = await fetch(`/api/projects/${projectId}/preassessments`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return;
      const d = await r.json();
      setPersonaId(d.preassessmentPersonaId || null);
      setById(Object.fromEntries((d.assessments || []).map((a: Preassessment) => [a.submissionId, a])));
    } catch { /* aanvullend: de inleveringen blijven zichtbaar */ }
  }, [projectId, token, enabled]);
  useEffect(() => { void load(); }, [load]);
  const anyPending = Object.values(byId).some((a) => a.status === 'pending');
  useEffect(() => {
    if (!anyPending) return;
    const id = setInterval(() => { void load(); }, 5000);
    return () => clearInterval(id);
  }, [anyPending, load]);
  const rerun = useCallback(async (submissionId: string) => {
    const r = await fetch(`/api/projects/${projectId}/submissions/${submissionId}/preassessment`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || '');
    setById((prev) => ({ ...prev, [submissionId]: { submissionId, status: 'pending', content: null, error: null, updatedAt: new Date().toISOString() } }));
    setTimeout(() => { void load(); }, 1500);
  }, [projectId, token, load]);
  const downloadWord = useCallback((submissionId: string) =>
    downloadBlob(`/api/projects/${projectId}/submissions/${submissionId}/preassessment.docx`, token, 'voorbeoordeling.docx'), [projectId, token]);
  const downloadAll = useCallback(() =>
    downloadBlob(`/api/projects/${projectId}/submissions-export.zip`, token, 'project.zip'), [projectId, token]);
  return { byId, personaId, setPersonaId, reload: load, rerun, downloadWord, downloadAll };
}

/** Kiezen welke Beoordelaar het eindproduct voorbeoordeelt. */
export function PreassessorPicker({ projectId, token, evaluators, value, rubricCount, onChange, onError, onInfo }: {
  projectId: string;
  token: string;
  evaluators: Array<{ id: string; name: string; avatar_emoji?: string }>;
  value: string | null;
  /** Aantal verborgen rubrics van de gekozen beoordelaar (undefined = onbekend). */
  rubricCount?: number;
  onChange: (id: string | null) => void;
  onError: (m: string) => void;
  onInfo: (m: string) => void;
}) {
  const { t } = useLanguage();
  const [saving, setSaving] = useState(false);
  const save = async (id: string | null) => {
    setSaving(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/preassessment-persona`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ personaId: id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '');
      onChange(id);
      onInfo(t('admin.projects.pre.saved'));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="rounded-lg border border-gray-200 p-3 space-y-2" data-testid="section-preassessor">
      <div className="flex items-center gap-1 font-medium text-gray-900 text-sm">
        {t('admin.projects.pre.title')}<HelpTip id="projects.preassessment" />
      </div>
      <AdminHint variant="intro">{t('admin.projects.pre.intro')}</AdminHint>
      {evaluators.length === 0 ? (
        <AdminHint variant="warning">{t('admin.projects.pre.noEvaluators')}</AdminHint>
      ) : (
        <>
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-gray-700">{t('admin.projects.pre.select')}</span>
            <select
              value={value || ''}
              disabled={saving}
              onChange={(e) => void save(e.target.value || null)}
              className="min-w-0 rounded border border-gray-300 px-2 py-1 text-sm"
              data-testid="select-preassessor"
            >
              <option value="">{t('admin.projects.pre.none')}</option>
              {evaluators.map((ev) => <option key={ev.id} value={ev.id}>{ev.avatar_emoji ? `${ev.avatar_emoji} ` : ''}{ev.name}</option>)}
            </select>
            {saving && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
          </label>
          {value && rubricCount === 0 && <AdminHint variant="warning">{t('admin.projects.pre.noRubric')}</AdminHint>}
          {value && <AdminHint variant="tip">{t('admin.projects.pre.excluded')}</AdminHint>}
        </>
      )}
    </div>
  );
}

/** Statuslabel bij een inlevering. */
export function PreassessmentBadge({ a }: { a?: Preassessment }) {
  const { t } = useLanguage();
  if (!a) return null;
  if (a.status === 'pending') return <StatusBadge tone="info" testId="badge-preassessment-pending"><Loader2 className="mr-1 inline h-3 w-3 animate-spin" />{t('admin.projects.pre.status.pending')}</StatusBadge>;
  if (a.status === 'failed') return <StatusBadge tone="danger" title={a.error || undefined} testId="badge-preassessment-failed">{t('admin.projects.pre.status.failed')}</StatusBadge>;
  return <StatusBadge tone="success" testId="badge-preassessment-done">{t('admin.projects.pre.status.done')}</StatusBadge>;
}

const INDICATION_TONE: Record<Indication, string> = {
  strong: 'bg-green-100 text-green-800',
  adequate: 'bg-blue-100 text-blue-800',
  weak: 'bg-orange-100 text-orange-800',
  unclear: 'bg-gray-100 text-gray-700',
};

/** De voorbeoordeling van één inlevering (modal). */
export function PreassessmentModal({ groupName, a, onClose, onRerun, onDownload }: {
  groupName: string;
  a: Preassessment | undefined;
  onClose: () => void;
  onRerun: () => void;
  onDownload: () => void;
}) {
  const { t } = useLanguage();
  const tk = (k: string, v?: Record<string, string>) => t(k as TKey, v);
  const c = a?.status === 'done' ? a.content : null;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" data-testid="modal-preassessment">
        <div className="flex items-center gap-2 border-b border-gray-100 px-5 py-3">
          <h3 className="min-w-0 flex-1 truncate font-semibold text-gray-900">{t('admin.projects.pre.modalTitle', { group: groupName })}</h3>
          <Tooltip label={t('admin.projects.pre.downloadWord')}>
            <button type="button" onClick={onDownload} className="rounded p-1.5 text-blue-600 hover:bg-blue-50" data-testid="button-preassessment-word"><FileDown className="h-4 w-4" /></button>
          </Tooltip>
          <Tooltip label={t('admin.projects.pre.rerun')}>
            <button type="button" onClick={onRerun} disabled={a?.status === 'pending'} className="rounded p-1.5 text-gray-600 hover:bg-gray-100 disabled:opacity-40" data-testid="button-preassessment-rerun"><RefreshCw className="h-4 w-4" /></button>
          </Tooltip>
          <Tooltip label={t('common.close')}>
            <button type="button" onClick={onClose} className="rounded p-1.5 text-gray-500 hover:bg-gray-100"><X className="h-4 w-4" /></button>
          </Tooltip>
        </div>
        <div className="space-y-4 overflow-y-auto px-5 py-4 text-sm">
          <AdminHint variant="intro">{tk('projects.preassessment.doc.disclaimer')}</AdminHint>
          {!a && <p className="text-gray-600">{tk('projects.preassessment.doc.none')}</p>}
          {a?.status === 'pending' && <p className="flex items-center gap-2 text-gray-600"><Loader2 className="h-4 w-4 animate-spin" />{tk('projects.preassessment.doc.pending')}</p>}
          {a?.status === 'failed' && (
            <AdminHint variant="warning">{tk('projects.preassessment.doc.failed')}{a.error ? `: ${a.error}` : ''}. {t('admin.projects.pre.failedHint')}</AdminHint>
          )}
          {c && (
            <>
              {(c.parts ?? 1) > 1 && <p className="text-xs text-gray-500">{tk('projects.preassessment.doc.longDoc', { n: String(c.parts) })}</p>}
              {c.truncated && <p className="text-xs text-gray-500">{tk('projects.preassessment.doc.truncated')}</p>}
              {!!c.rubricFiles?.length && <p className="text-xs text-gray-500">{t('admin.projects.pre.rubricFiles', { files: c.rubricFiles.join(', ') })}</p>}
              <section>
                <h4 className="font-semibold text-gray-900">{tk('projects.preassessment.doc.summary')}</h4>
                <p className="mt-1 whitespace-pre-line text-gray-800">{c.summary}</p>
              </section>
              <section className="space-y-3">
                <h4 className="font-semibold text-gray-900">{tk('projects.preassessment.doc.criteria')}</h4>
                {c.criteria.map((cr, i) => (
                  <div key={i} className="rounded-lg border border-gray-200 p-3" data-testid="preassessment-criterion">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 font-medium text-gray-900">{cr.criterion}</span>
                      <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${INDICATION_TONE[cr.indication] || INDICATION_TONE.unclear}`}>
                        {tk(`projects.preassessment.doc.indication.${cr.indication}`)}
                      </span>
                    </div>
                    {([['strengths', cr.strengths], ['concerns', cr.concerns]] as const).map(([k, items]) => items.length > 0 && (
                      <div key={k} className="mt-2">
                        <div className="text-xs font-semibold text-gray-600">{tk(`projects.preassessment.doc.${k}`)}</div>
                        <ul className="ml-4 list-disc text-gray-800">{items.map((s, j) => <li key={j}>{s}</li>)}</ul>
                      </div>
                    ))}
                    {cr.quotes.length > 0 && (
                      <div className="mt-2">
                        <div className="text-xs font-semibold text-gray-600">{tk('projects.preassessment.doc.quotes')}</div>
                        {cr.quotes.map((q, j) => <blockquote key={j} className="mt-1 border-l-2 border-gray-300 pl-2 italic text-gray-700">“{q}”</blockquote>)}
                      </div>
                    )}
                  </div>
                ))}
              </section>
              {c.attention.length > 0 && (
                <section>
                  <h4 className="font-semibold text-gray-900">{tk('projects.preassessment.doc.attention')}</h4>
                  <ul className="ml-4 mt-1 list-disc text-gray-800">{c.attention.map((s, j) => <li key={j}>{s}</li>)}</ul>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Knop "Alles downloaden (zip)". */
export function DownloadAllButton({ onClick }: { onClick: () => Promise<void> }) {
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  return (
    <Tooltip label={t('admin.projects.pre.downloadAllHint')}>
      <button
        type="button"
        disabled={busy}
        onClick={async () => { setBusy(true); try { await onClick(); } finally { setBusy(false); } }}
        className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"
        data-testid="button-download-all-submissions"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}{t('admin.projects.pre.downloadAll')}
      </button>
    </Tooltip>
  );
}
