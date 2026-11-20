import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Search, Send } from 'lucide-react';
import { useLanguage } from '../../i18n';
import {
  fetchCatalog, fetchMyAccess, sendAccessRequest, AccessError,
  type CatalogCourse, type MyAccess, type RoleWish,
} from '../../services/access.service';

/**
 * Welkom voor wie (nog) in geen cursus zit. Medewerkers (@vu.nl, @amsterdamumc.nl)
 * kunnen de beheerder een vraag stellen en de beschikbare cursussen bekijken en
 * aanvinken. Anderen krijgen alleen de uitleg. Rendert niets als je al in een cursus zit.
 */
export function NoCourseWelcome({ fallback = null }: { fallback?: React.ReactNode }) {
  const { t } = useLanguage();
  const [me, setMe] = useState<MyAccess | null>(null);
  const [catalog, setCatalog] = useState<CatalogCourse[] | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [role, setRole] = useState<RoleWish>('unsure');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => { fetchMyAccess().then(setMe).catch(() => setMe(null)); }, []);

  const showCatalog = async () => {
    setOpen((o) => !o);
    if (catalog === null) fetchCatalog().then(setCatalog).catch(() => setCatalog([]));
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (catalog || []).filter((c) => !q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q));
  }, [catalog, query]);

  if (!me) return <>{fallback}</>;
  if (me.courseCount > 0) return <>{fallback}</>;

  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const names = (catalog || []).filter((c) => chosen.includes(c.id)).map((c) => c.name);
  const openRequests = me.requests.filter((r) => r.status === 'open');

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await sendAccessRequest({ message, courseIds: chosen, role });
      setSent(true);
      setMessage('');
      setChosen([]);
      setMe(await fetchMyAccess());
    } catch (e) {
      setError(e instanceof AccessError && e.code === 'tooMany' ? t('access.tooMany') : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chic-card space-y-4 p-6 text-left" data-testid="panel-no-course-welcome">
      <div>
        <h2 className="text-xl font-bold text-gray-900">{t('access.welcomeTitle')}</h2>
        <p className="mt-1 text-sm text-gray-700">{me.staff ? t('access.welcomeStaff') : t('access.welcomeOther')}</p>
      </div>

      {me.staff && (
        <>
          {openRequests.length > 0 && (
            <p className="flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800" data-testid="text-request-pending">
              <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" />{t('access.pending', { n: String(openRequests.length) })}
            </p>
          )}
          {sent && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800" data-testid="text-request-sent">{t('access.sent')}</p>}

          <div className="space-y-2">
            <button type="button" onClick={() => void showCatalog()} className="inline-flex items-center gap-1.5 text-sm font-semibold text-sky-800 hover:underline" aria-expanded={open} data-testid="button-show-catalog">
              {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}{t('access.showCourses')}
            </button>
            {open && (
              <div className="space-y-2" data-testid="panel-catalog">
                <label className="relative block">
                  <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-gray-400" />
                  <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('access.search')} aria-label={t('access.search')} className="w-full rounded-lg border border-gray-300 py-1.5 pl-8 pr-3 text-sm" data-testid="input-catalog-search" />
                </label>
                {catalog === null ? (
                  <p className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" />{t('access.loading')}</p>
                ) : (
                  <ul className="max-h-64 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-100" data-testid="list-catalog">
                    {filtered.map((c) => (
                      <li key={c.id}>
                        <label className="flex cursor-pointer items-start gap-2 px-3 py-1 text-sm leading-tight hover:bg-gray-50">
                          <input type="checkbox" className="mt-0.5" checked={chosen.includes(c.id)} onChange={() => toggle(c.id)} data-testid={`checkbox-catalog-${c.id}`} />
                          <span className="min-w-0">
                            <span className="font-medium text-gray-900">{c.name}</span>
                            {c.description && <span className="block truncate text-xs text-gray-500">{c.description}</span>}
                          </span>
                        </label>
                      </li>
                    ))}
                    {filtered.length === 0 && <li className="px-3 py-2 text-sm text-gray-500">{t('access.noMatch')}</li>}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2" data-testid="form-access-request">
            <p className="text-sm font-semibold text-gray-900">{t('access.askTitle')}</p>
            {names.length > 0 && <p className="text-xs text-gray-600" data-testid="text-chosen-courses">{t('access.chosen', { names: names.join(', ') })}</p>}
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} maxLength={2000} placeholder={t('access.messagePlaceholder')} aria-label={t('access.askTitle')} className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm" data-testid="textarea-access-message" />
            <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-700">
              <legend className="sr-only">{t('access.roleLabel')}</legend>
              {(['teacher', 'student', 'unsure'] as const).map((r) => (
                <label key={r} className="inline-flex items-center gap-1.5">
                  <input type="radio" name="role-wish" checked={role === r} onChange={() => setRole(r)} data-testid={`radio-role-${r}`} />
                  {t(r === 'teacher' ? 'access.role.teacher' : r === 'student' ? 'access.role.student' : 'access.role.unsure')}
                </label>
              ))}
            </fieldset>
            <button type="button" onClick={() => void submit()} disabled={busy || (!message.trim() && chosen.length === 0)} className="btn-primary inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-50" data-testid="button-send-access-request">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}{t('access.send')}
            </button>
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
          </div>
        </>
      )}
    </div>
  );
}
