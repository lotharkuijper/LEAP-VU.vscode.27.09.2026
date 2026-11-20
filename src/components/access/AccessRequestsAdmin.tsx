import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, UserPlus } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { AdminHint } from '../help/AdminHint';
import {
  closeAccessRequest, fetchAccessRequests, grantAccess,
  type AdminAccessRequest, type CatalogCourse,
} from '../../services/access.service';

/** Beheer: toegangsaanvragen van medewerkers. Koppel aan een cursus als docent of student en sluit af. */
export function AccessRequestsAdmin() {
  const { t } = useLanguage();
  const [all, setAll] = useState(false);
  const [data, setData] = useState<{ courses: CatalogCourse[]; requests: AdminAccessRequest[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchAccessRequests(all).then(setData).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [all]);
  useEffect(() => { load(); }, [load]);

  if (error) return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>;
  if (!data) return <p className="flex items-center gap-2 text-sm text-gray-600"><Loader2 className="h-4 w-4 animate-spin" />{t('access.loading')}</p>;

  const courseName = (id: string) => data.courses.find((c) => c.id === id)?.name || id;

  return (
    <div className="space-y-4" data-testid="panel-access-requests">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold text-gray-900">{t('admin.tabs.accessRequests')}</h2>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} data-testid="checkbox-access-all" />{t('access.admin.showClosed')}
        </label>
      </div>
      <AdminHint variant="intro">{t('access.admin.intro')}</AdminHint>
      {data.requests.length === 0 ? (
        <p className="text-sm text-gray-500" data-testid="text-no-access-requests">{t('access.admin.none')}</p>
      ) : (
        <ul className="space-y-3">
          {data.requests.map((r) => <RequestRow key={r.id} r={r} courses={data.courses} courseName={courseName} onChanged={load} />)}
        </ul>
      )}
    </div>
  );
}

function RequestRow({ r, courses, courseName, onChanged }: {
  r: AdminAccessRequest;
  courses: CatalogCourse[];
  courseName: (id: string) => string;
  onChanged: () => void;
}) {
  const { t } = useLanguage();
  const [courseId, setCourseId] = useState(r.wished.find((id) => !r.granted.includes(id)) || '');
  const [role, setRole] = useState<'teacher' | 'student'>(r.role === 'student' ? 'student' : 'teacher');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await fn(); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const roleLabel = r.role === 'teacher' ? t('access.role.teacher') : r.role === 'student' ? t('access.role.student') : t('access.role.unsure');
  return (
    <li className="chic-card space-y-2 p-4" data-testid={`row-access-${r.id}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium text-gray-900">{r.user.name || r.user.email} <span className="text-sm font-normal text-gray-500">&lt;{r.user.email}&gt;</span></p>
        <span className="text-xs text-gray-500">{new Date(r.createdAt).toLocaleDateString()} · {roleLabel}{r.status === 'closed' ? ` · ${t('access.admin.closed')}` : ''}</span>
      </div>
      {r.message && <p className="whitespace-pre-wrap text-sm text-gray-700">{r.message}</p>}
      {r.wished.length > 0 && <p className="text-xs text-gray-600">{t('access.admin.wished', { names: r.wished.map(courseName).join(', ') })}</p>}
      {r.granted.length > 0 && <p className="text-xs text-emerald-700">{t('access.admin.granted', { names: r.granted.map(courseName).join(', ') })}</p>}
      {r.status === 'open' && (
        <div className="flex flex-wrap items-center gap-2">
          <select value={courseId} onChange={(e) => setCourseId(e.target.value)} className="min-w-[14rem] rounded-lg border border-gray-300 px-2 py-1.5 text-sm" aria-label={t('access.admin.course')} data-testid={`select-access-course-${r.id}`}>
            <option value="">{t('access.admin.course')}</option>
            {courses.map((c) => <option key={c.id} value={c.id}>{r.wished.includes(c.id) ? '★ ' : ''}{c.name}</option>)}
          </select>
          <select value={role} onChange={(e) => setRole(e.target.value as 'teacher' | 'student')} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" aria-label={t('access.roleLabel')} data-testid={`select-access-role-${r.id}`}>
            <option value="teacher">{t('access.role.teacher')}</option>
            <option value="student">{t('access.role.student')}</option>
          </select>
          <button type="button" onClick={() => void run(async () => {
            const g = await grantAccess(r.id, courseId, role);
            setNote(g.previousRole && g.previousRole !== role
              ? t('access.admin.roleChanged', { from: t(g.previousRole === 'teacher' ? 'access.role.teacher' : 'access.role.student'), to: t(role === 'teacher' ? 'access.role.teacher' : 'access.role.student') })
              : g.previousRole ? t('access.admin.alreadyMember') : null);
          })} disabled={busy || !courseId} className="btn-primary inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm font-semibold disabled:opacity-50" data-testid={`button-grant-${r.id}`}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}{t('access.admin.grant')}
          </button>
          <button type="button" onClick={() => void run(() => closeAccessRequest(r.id))} disabled={busy} className="inline-flex items-center gap-1.5 rounded-xl border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50" data-testid={`button-close-access-${r.id}`}>
            <Check className="h-4 w-4" />{t('access.admin.close')}
          </button>
        </div>
      )}
      {note && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid={`text-access-note-${r.id}`}>{note}</p>}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
    </li>
  );
}
