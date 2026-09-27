import { useMemo, useState } from 'react';
import { ClipboardCheck, Loader2, CheckCircle2 } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { HelpTip } from '../help/HelpTip';
import {
  applyReview,
  type CourseFile,
  type CourseProject,
  type PurposeDecision,
} from '../../services/course-files.service';
import { PurposeChip } from './purposeUi';
import { PurposeSelect, type PurposeValue } from './PurposePicker';

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];

/**
 * Eenmalige controle: voor elk bestand zonder bevestigd doel toont LEAP een
 * voorstel (met reden en zekerheid). De docent past aan waar nodig en
 * bevestigt alles in één keer. Bestanden met een ánder doel dan nu worden
 * daarbij door de server naar de juiste plek verplaatst.
 */
export function PurposeReview({
  courseId,
  files,
  projects,
  onDone,
  onLater,
}: {
  courseId: string;
  files: CourseFile[];
  projects: CourseProject[];
  onDone: () => void;
  onLater?: () => void;
}) {
  const { t } = useLanguage();
  const tk = (k: string, v?: Record<string, string>) => t(k as TKey, v);
  const pending = useMemo(() => files.filter(f => !f.purposeConfirmed), [files]);
  const [choices, setChoices] = useState<Record<string, PurposeValue>>(() =>
    Object.fromEntries(pending.map(f => [f.id, {
      purpose: f.suggestion?.purpose ?? f.purpose,
      materialKind: f.suggestion?.materialKind,
    }])),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const changes = pending.filter(f => (choices[f.id]?.purpose ?? f.purpose) !== f.purpose).length;
  const missingProject = pending.some(f => choices[f.id]?.purpose === 'project' && !choices[f.id]?.projectId);

  const confirm = async () => {
    setBusy(true);
    setMessage(null);
    const decisions: PurposeDecision[] = pending.map(f => ({ docId: f.id, ...(choices[f.id] ?? { purpose: f.purpose }) }));
    try {
      const r = await applyReview(courseId, decisions);
      const failed = r.results.filter(x => !x.ok).length;
      if (failed === 0) setMessage({ kind: 'ok', text: t('material.review.done') });
      else setMessage({ kind: 'error', text: t('material.review.partial', { ok: String(r.results.length - failed), failed: String(failed) }) });
      onDone();
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  if (pending.length === 0) {
    return message ? (
      <div className="flex items-center gap-2 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3" data-testid="text-review-done">
        <CheckCircle2 className="w-4 h-4" /> {message.text}
      </div>
    ) : null;
  }

  return (
    <section className="rounded-2xl border-2 border-fuchsia-200 bg-gradient-to-br from-fuchsia-50 via-white to-sky-50 p-5 space-y-4" data-testid="panel-purpose-review">
      <div className="flex items-start gap-3">
        <ClipboardCheck className="w-6 h-6 text-fuchsia-600 flex-shrink-0" />
        <div>
          <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">{t('material.review.title')}<HelpTip id="material.review" /></h3>
          <p className="text-sm text-gray-700 mt-1">{t('material.review.intro')}</p>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs text-gray-600">
            <tr>
              <th className="px-3 py-2">{t('material.review.file')}</th>
              <th className="px-3 py-2">{t('material.review.suggestion')}</th>
              <th className="px-3 py-2">{t('material.review.choice')}</th>
            </tr>
          </thead>
          <tbody>
            {pending.map(f => {
              const s = f.suggestion;
              return (
                <tr key={f.id} className="border-t border-gray-100 align-top" data-testid={`row-review-${f.id}`}>
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-900">{f.title}</div>
                    <div className="text-xs text-gray-500">{f.folderName}</div>
                  </td>
                  <td className="px-3 py-2">
                    {s ? (
                      <div className="space-y-1">
                        <PurposeChip purpose={s.purpose} label={tk(`filePurpose.${s.purpose}.label`)} />
                        <div className="text-xs text-gray-600">
                          {tk(`filePurpose.reason.${s.reason}`)} · <span className="italic">{tk(`filePurpose.confidence.${s.confidence}`)}</span>
                        </div>
                      </div>
                    ) : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <PurposeSelect
                      value={choices[f.id] ?? { purpose: f.purpose }}
                      onChange={v => setChoices(c => ({ ...c, [f.id]: v }))}
                      projects={projects}
                      testId={`select-review-${f.id}`}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-600" data-testid="text-review-changes">
        {changes > 0 ? t('material.review.changesHint', { n: String(changes) }) : t('material.review.allSame')}
      </p>

      {message && (
        <p className={`text-sm rounded-lg px-3 py-2 ${message.kind === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>{message.text}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={confirm}
          disabled={busy || missingProject}
          className="btn-primary px-4 py-2 rounded-xl text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
          data-testid="button-review-confirm"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
          {busy ? t('material.review.applying') : t('material.review.confirmAll', { n: String(pending.length) })}
        </button>
        {onLater && !busy && (
          <button type="button" onClick={onLater} className="px-3 py-2 text-sm text-gray-600 hover:text-gray-900" data-testid="button-review-later">
            {t('material.review.later')}
          </button>
        )}
        {missingProject && <span className="text-xs text-amber-700">{t('filePurpose.error.projectRequired')}</span>}
      </div>
    </section>
  );
}
