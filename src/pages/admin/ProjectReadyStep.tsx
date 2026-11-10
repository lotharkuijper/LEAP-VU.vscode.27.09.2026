// Stap 6 van een project inrichten: klaar voor studenten. Een controlelijst
// (setupIssues), uitleg over zelf uitproberen in een eigen testgroep, en de knop
// waarmee de docent het concept opent voor studenten (of terugzet naar concept).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, FlaskConical, Info, Loader2, Lock, Rocket } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { AdminHint } from '../../components/help/AdminHint';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription,
  AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '../../components/ui/alert-dialog';
import type { ProjectStep, SetupIssue } from './ProjectSetupSteps';

export function ProjectReadyStep({ projectId, status, issues, token, onGoTo, onStatusChanged, onError }: {
  projectId: string;
  status: string | null;
  issues: SetupIssue[];
  token: string;
  onGoTo: (s: ProjectStep) => void;
  onStatusChanged: (status: string) => void;
  onError: (m: string) => void;
}) {
  const { t } = useLanguage();
  const [confirm, setConfirm] = useState<'active' | 'draft' | null>(null);
  const [busy, setBusy] = useState(false);
  const isDraft = status === 'draft';
  const isArchived = status === 'archived';
  const blocking = issues.filter((i) => !i.optional);
  const optional = issues.filter((i) => i.optional);

  const setStatus = async (next: 'active' | 'draft') => {
    setBusy(true);
    try {
      const r = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || t('admin.projects.ready.failed'));
      onStatusChanged(next);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const issueRow = (i: SetupIssue, n: number) => (
    <li key={`${i.step}-${i.key}-${n}`} className="flex flex-wrap items-center gap-2 py-1.5 text-sm" data-testid={`ready-issue-${i.key}`}>
      {i.optional ? <Info className="h-4 w-4 shrink-0 text-gray-400" /> : <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />}
      <span className="min-w-0 flex-1 basis-48">{t(`admin.projects.ready.issue.${i.key}` as 'admin.projects.ready.issue.noBriefing', i.vars)}</span>
      <button type="button" onClick={() => onGoTo(i.step)} className="text-xs font-medium text-sky-700 hover:underline">
        {t('admin.projects.ready.goTo', { step: t(`admin.projects.steps.${i.step}` as 'admin.projects.steps.task') })}
      </button>
    </li>
  );

  return (
    <div className="space-y-4">
      <div className="chic-card p-5 space-y-3" data-testid="section-project-ready">
        <div>
          <h3 className="font-semibold text-gray-900">{t('admin.projects.ready.title')}</h3>
          <AdminHint variant="intro">{t('admin.projects.ready.intro')}</AdminHint>
        </div>
        {blocking.length === 0 ? (
          <p className="flex items-center gap-1.5 text-sm text-emerald-700" data-testid="text-ready-ok"><CheckCircle2 className="h-4 w-4" />{t('admin.projects.ready.allOk')}</p>
        ) : (
          <ul className="divide-y divide-gray-100">{blocking.map(issueRow)}</ul>
        )}
        {optional.length > 0 && (
          <div>
            <p className="text-xs font-medium text-gray-600">{t('admin.projects.ready.optionalTitle')}</p>
            <ul className="divide-y divide-gray-100">{optional.map(issueRow)}</ul>
          </div>
        )}
      </div>

      <div className="chic-card p-5 space-y-2" data-testid="section-project-tryout">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2"><FlaskConical className="h-4 w-4" />{t('admin.projects.ready.tryTitle')}</h3>
        <p className="text-sm text-gray-700">{t(isDraft ? 'admin.projects.ready.tryDraft' : 'admin.projects.ready.tryOpen')}</p>
        <Link to="/projects" className="inline-flex items-center gap-1.5 text-sm font-medium text-sky-700 hover:underline" data-testid="link-project-tryout">
          {t('admin.projects.ready.tryLink')}
        </Link>
      </div>

      <div className="chic-card p-5 space-y-3" data-testid="section-project-status">
        <h3 className="font-semibold text-gray-900">{t('admin.projects.ready.statusTitle')}</h3>
        <p className="text-sm text-gray-700" data-testid="text-project-status">
          {t(isDraft ? 'admin.projects.ready.isDraft' : isArchived ? 'admin.projects.ready.isArchived' : 'admin.projects.ready.isOpen')}
        </p>
        {isDraft && (
          <button type="button" disabled={busy} onClick={() => setConfirm('active')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-700 disabled:opacity-40" data-testid="button-open-project">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}{t('admin.projects.ready.openBtn')}
          </button>
        )}
        {!isDraft && !isArchived && (
          <button type="button" disabled={busy} onClick={() => setConfirm('draft')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40" data-testid="button-back-to-draft">
            <Lock className="h-4 w-4" />{t('admin.projects.ready.backToDraftBtn')}
          </button>
        )}
      </div>

      <AlertDialog open={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(confirm === 'draft' ? 'admin.projects.ready.backToDraftTitle' : 'admin.projects.ready.openTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(confirm === 'draft' ? 'admin.projects.ready.backToDraftBody' : blocking.length ? 'admin.projects.ready.openBodyIssues' : 'admin.projects.ready.openBody', { n: String(blocking.length) })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('admin.projects.cancelBtn')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirm && void setStatus(confirm)} data-testid="button-confirm-project-status">
              {t(confirm === 'draft' ? 'admin.projects.ready.backToDraftBtn' : 'admin.projects.ready.openBtn')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
