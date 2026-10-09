// Mijn gegevens (2026-10-09): je eigen gegevens downloaden, je leerdossier
// afdrukken of als PDF bewaren, en je account verwijderen. Server: server/myData.js.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, FileText, Trash2, ShieldCheck, Loader2 } from 'lucide-react';
import { useLanguage } from '../i18n';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { buildDossierHtml } from '../lib/learningDossier';

type ExportData = { exportedAt: string; user: { email: string | null }; sources: Record<string, Record<string, unknown>[]> };

export function MyDataPage() {
  const { t } = useLanguage();
  const { session, profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<null | 'json' | 'pdf' | 'delete'>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmEmail, setConfirmEmail] = useState('');

  async function fetchExport(): Promise<ExportData> {
    const r = await fetch('/api/me/export', { headers: { Authorization: `Bearer ${session?.access_token}` } });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d as ExportData;
  }

  async function downloadJson() {
    setBusy('json'); setError(null);
    try {
      const data = await fetchExport();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `leap-mijn-gegevens-${data.exportedAt.slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function printDossier() {
    setBusy('pdf'); setError(null);
    // Venster direct openen (anders blokkeert de browser het als pop-up).
    const win = window.open('', '_blank');
    try {
      const data = await fetchExport();
      const { data: courses } = await supabase.from('courses').select('id, name');
      const courseNames = Object.fromEntries(((courses || []) as { id: string; name: string }[]).map(c => [c.id, c.name]));
      const levelNames = Object.fromEntries([1, 2, 3, 4, 5].map(n => [n, t(`learningLevel.level${n as 1 | 2 | 3 | 4 | 5}.label`)]));
      const html = buildDossierHtml(data, {
        title: t('myData.dossier.title'),
        exportedOn: t('myData.dossier.exportedOn'),
        achievements: t('myData.dossier.achievements'),
        noAchievements: t('myData.dossier.noAchievements'),
        levels: t('myData.dossier.levels'),
        level: t('myData.dossier.level'),
        journal: t('myData.dossier.journal'),
        noJournal: t('myData.dossier.noJournal'),
        levelNames,
        courseUnknown: t('myData.dossier.courseUnknown'),
      }, { locale: t('common.locale'), courseNames });
      if (!win) throw new Error(t('myData.popupBlocked'));
      win.document.open();
      win.document.write(html);
      win.document.close();
      win.focus();
      setTimeout(() => win.print(), 300);
    } catch (e) {
      win?.close();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const ownEmail = (profile?.email || '').trim().toLowerCase();
  const canDelete = ownEmail !== '' && confirmEmail.trim().toLowerCase() === ownEmail && profile?.role !== 'admin';

  async function deleteAccount() {
    if (!canDelete) return;
    setBusy('delete'); setError(null);
    try {
      const r = await fetch('/api/me/delete-account', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmEmail }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      await signOut();
      navigate('/login', { replace: true, state: { notice: 'accountDeleted' } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6" data-testid="page-my-data">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 mb-2 flex items-center gap-3">
          <ShieldCheck className="w-8 h-8 text-brand-600" />
          {t('myData.title')}
        </h1>
        <p className="text-gray-600">{t('myData.intro')}</p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert" data-testid="text-my-data-error">
          {error}
        </div>
      )}

      <section className="chic-card p-5 space-y-3" data-testid="card-export">
        <h2 className="text-lg font-semibold text-gray-900">{t('myData.export.title')}</h2>
        <p className="text-sm text-gray-600">{t('myData.export.body')}</p>
        <div className="flex flex-wrap gap-2">
          <button onClick={printDossier} disabled={busy !== null}
            className="flex items-center gap-2 whitespace-nowrap rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            data-testid="button-print-dossier">
            {busy === 'pdf' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
            {t('myData.export.dossierButton')}
          </button>
          <button onClick={downloadJson} disabled={busy !== null}
            className="flex items-center gap-2 whitespace-nowrap rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            data-testid="button-download-json">
            {busy === 'json' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {t('myData.export.jsonButton')}
          </button>
        </div>
        <p className="text-xs text-gray-500">{t('myData.export.note')}</p>
      </section>

      <section className="chic-card p-5 space-y-3" data-testid="card-traces">
        <h2 className="text-lg font-semibold text-gray-900">{t('myData.traces.title')}</h2>
        <p className="text-sm text-gray-600">{t('myData.traces.body')}</p>
      </section>

      <section className="rounded-2xl border border-red-200 bg-red-50/60 p-5 space-y-3" data-testid="card-delete-account">
        <h2 className="text-lg font-semibold text-red-800 flex items-center gap-2">
          <Trash2 className="w-5 h-5" />
          {t('myData.delete.title')}
        </h2>
        <p className="text-sm text-red-900">{t('myData.delete.body')}</p>
        {profile?.role === 'admin' ? (
          <p className="text-sm text-red-900" data-testid="text-admin-cannot-delete">{t('myData.delete.adminNote')}</p>
        ) : (
          <>
            <label className="block text-sm text-red-900">
              {t('myData.delete.confirmLabel', { email: profile?.email || '' })}
              <input
                type="email"
                value={confirmEmail}
                onChange={e => setConfirmEmail(e.target.value)}
                autoComplete="off"
                className="mt-1 w-full rounded-lg border border-red-300 bg-white px-3 py-2 text-sm text-gray-900"
                data-testid="input-confirm-email"
              />
            </label>
            <button onClick={deleteAccount} disabled={!canDelete || busy !== null}
              className="flex items-center gap-2 whitespace-nowrap rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              data-testid="button-delete-account">
              {busy === 'delete' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              {t('myData.delete.button')}
            </button>
          </>
        )}
      </section>
    </div>
  );
}
