import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, Loader2, UserCheck, X } from 'lucide-react';
import { useLanguage } from '../i18n';
import { supabase } from '../lib/supabase';
import { AdminHint } from './help/AdminHint';
import { HelpTip } from './help/HelpTip';

// Nieuwe editie van een cursus (server/courseEditions.js): eerst zien wat er
// gebeurt, dan bevestigen. Daaronder de oud-deelnemers, met "weer actief maken".

interface Preview {
  students: number;
  teachers: Array<{ id: string; name: string | null; email: string | null }>;
  projects: number;
  groups: number;
  threads: number;
  canvasCourses: string[];
  editions: Array<{ id: string; label: string | null; started_at: string }>;
  alumniList: Array<{ userId: string; formerRole: string; since: string; name: string | null; email: string | null }>;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

export function CourseEditionDialog({ courseId, courseName, currentUserId, onClose }: {
  courseId: string;
  courseName: string;
  currentUserId: string | null;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const [info, setInfo] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch(`/api/courses/${encodeURIComponent(courseId)}/editions`, { headers: await authHeaders() });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setInfo(d as Preview);
      // Standaard blijven alle huidige docenten; de docent vinkt oud-assistenten uit.
      setKeep(new Set((d as Preview).teachers.map(x => x.id)));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => { load(); }, [courseId]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/courses/${encodeURIComponent(courseId)}/editions`, {
        method: 'POST', headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, keepTeacherIds: [...keep], confirm: true }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      const s = d.summary || {};
      setDone(t('editions.done', {
        students: String(s.alumniStudents ?? 0), teachers: String(s.alumniTeachers ?? 0),
        projects: String(s.projects ?? 0), threads: String(s.threads ?? 0),
      }));
      setConfirm(false);
      setLabel('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reactivate = async (userId: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/courses/${encodeURIComponent(courseId)}/alumni/${encodeURIComponent(userId)}/reactivate`, {
        method: 'POST', headers: await authHeaders(),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const fmtDate = (s: string) => new Date(s).toLocaleDateString(t('common.locale'));

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={t('editions.title')} className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl" data-testid="dialog-course-edition">
        <div className="mb-3 flex items-center gap-2">
          <Archive className="h-5 w-5 text-blue-600" aria-hidden="true" />
          <h2 className="min-w-0 flex-1 text-lg font-semibold text-gray-900">{t('editions.title')}: {courseName}</h2>
          <HelpTip id="courses.edition" />
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-500 hover:bg-gray-100" aria-label={t('common.cancelAction')}><X className="h-5 w-5" /></button>
        </div>

        {error && <p className="mb-3 text-sm text-red-700" role="alert">{error}</p>}
        {done && <AdminHint variant="intro">{done}</AdminHint>}
        {!info && !error && <p className="text-sm text-gray-500">{t('common.loading')}</p>}

        {info && (
          <div className="space-y-4">
            <AdminHint variant="intro">{t('editions.intro')}</AdminHint>

            {info.editions.length > 0 && (
              <p className="text-xs text-gray-600" data-testid="text-editions-history">
                {t('editions.history', { list: info.editions.map(e => `${e.label || t('editions.unnamed')} (${fmtDate(e.started_at)})`).join(', ') })}
              </p>
            )}

            <div>
              <p className="mb-1 text-sm font-medium text-gray-800">{t('editions.whatHappens')}</p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
                <li>{t('editions.effectStudents', { n: String(info.students) })}</li>
                <li>{t('editions.effectProjects', { projects: String(info.projects), groups: String(info.groups) })}</li>
                <li>{t('editions.effectThreads', { n: String(info.threads) })}</li>
                {info.canvasCourses.length > 0 && <li>{t('editions.effectCanvas', { list: info.canvasCourses.join(', ') })}</li>}
                <li>{t('editions.effectKept')}</li>
              </ul>
            </div>

            {info.teachers.length > 0 && (
              <div>
                <p className="mb-1 text-sm font-medium text-gray-800">{t('editions.teachersTitle')}</p>
                <ul className="space-y-1">
                  {info.teachers.map(x => {
                    const self = x.id === currentUserId;
                    return (
                      <li key={x.id}>
                        <label className="flex items-center gap-2 text-sm text-gray-700">
                          <input
                            type="checkbox" checked={self || keep.has(x.id)} disabled={self}
                            onChange={(e) => setKeep(prev => { const n = new Set(prev); if (e.target.checked) n.add(x.id); else n.delete(x.id); return n; })}
                            data-testid={`checkbox-keep-teacher-${x.id}`}
                          />
                          <span className="min-w-0 break-words">{x.name || x.email || x.id}{self ? ` (${t('editions.you')})` : ''}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-1 text-xs text-gray-500">{t('editions.teachersHint')}</p>
              </div>
            )}

            <label className="block">
              <span className="text-sm font-medium text-gray-800">{t('editions.label')}</span>
              <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} placeholder={t('editions.labelPlaceholder')}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" data-testid="input-edition-label" />
            </label>

            <label className="flex items-start gap-2 text-sm text-gray-800">
              <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5" data-testid="checkbox-edition-confirm" />
              <span>{t('editions.confirm')}</span>
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={start} disabled={!confirm || busy}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" data-testid="button-start-edition">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}{t('editions.start')}
              </button>
              <button type="button" onClick={onClose} className="whitespace-nowrap rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">{t('common.cancelAction')}</button>
            </div>

            <div className="border-t border-gray-200 pt-3">
              <p className="mb-1 text-sm font-medium text-gray-800">{t('editions.alumniTitle', { n: String(info.alumniList.length) })}</p>
              {info.alumniList.length === 0 ? (
                <p className="text-sm text-gray-500">{t('editions.alumniNone')}</p>
              ) : (
                <>
                  <p className="mb-2 text-xs text-gray-500">{t('editions.alumniHint')}</p>
                  <ul className="max-h-60 space-y-1 overflow-y-auto" data-testid="list-course-alumni">
                    {info.alumniList.map(a => (
                      <li key={a.userId} className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="min-w-0 flex-1 break-words text-gray-700">
                          {a.name || a.email || a.userId}
                          <span className="text-xs text-gray-500"> · {t(a.formerRole === 'teacher' ? 'editions.formerTeacher' : 'editions.formerStudent')} · {fmtDate(a.since)}</span>
                        </span>
                        <button type="button" onClick={() => reactivate(a.userId)}
                          className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50" data-testid={`button-reactivate-${a.userId}`}>
                          <UserCheck className="h-3.5 w-3.5" />{t('editions.reactivate')}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
