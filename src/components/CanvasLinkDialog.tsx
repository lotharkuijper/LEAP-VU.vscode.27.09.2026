import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Link2, X } from 'lucide-react';
import { useLanguage } from '../i18n';
import { supabase } from '../lib/supabase';
import { AdminHint } from './help/AdminHint';
import { HelpTip } from './help/HelpTip';

// Canvas-link van een LEAP-cursus (server/lti.js). De docent zet de link in
// Canvas als externe tool; studenten komen dan met één klik, zonder
// wachtwoord, in deze cursus.

interface LinkInfo {
  configured: boolean;
  canvasMode: boolean;
  link: string;
  configUrl: string;
  canvasCourses: Array<{ title: string | null; lastSeen: string }>;
}

export function CanvasLinkDialog({ courseId, courseName, isAdmin, onClose }: {
  courseId: string;
  courseName: string;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(`/api/lti/course-link/${encodeURIComponent(courseId)}`, {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        setInfo(d as LinkInfo);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [courseId]);

  const copy = async (text: string, key: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(null), 2000); } catch { /* selecteer zelf */ }
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={t('canvasLink.title')} className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl" data-testid="dialog-canvas-link">
        <div className="mb-3 flex items-center gap-2">
          <Link2 className="h-5 w-5 text-blue-600" aria-hidden="true" />
          <h2 className="min-w-0 flex-1 text-lg font-semibold text-gray-900">{t('canvasLink.title')}: {courseName}</h2>
          <HelpTip id="courses.canvasLink" />
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-500 hover:bg-gray-100" aria-label={t('common.cancelAction')}><X className="h-5 w-5" /></button>
        </div>

        {error && <p className="text-sm text-red-700">{error}</p>}
        {!info && !error && <p className="text-sm text-gray-500">{t('common.loading')}</p>}

        {info && (
          <div className="space-y-4">
            {!info.configured && <AdminHint variant="warning" testId="warning-lti-not-configured">{t('canvasLink.notConfigured')}</AdminHint>}
            {!info.canvasMode && <AdminHint variant="warning">{t('canvasLink.notCanvasMode')}</AdminHint>}

            <div>
              <p className="mb-1 text-sm font-medium text-gray-800">{t('canvasLink.linkLabel')}</p>
              <div className="flex items-center gap-2">
                <input readOnly value={info.link} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-xs" data-testid="input-canvas-link" />
                <button type="button" onClick={() => copy(info.link, 'link')} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700" data-testid="button-copy-canvas-link">
                  {copied === 'link' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied === 'link' ? t('canvasLink.copied') : t('canvasLink.copy')}
                </button>
              </div>
            </div>

            <div>
              <p className="mb-1 text-sm font-medium text-gray-800">{t('canvasLink.stepsTitle')}</p>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-700">
                <li>{t('canvasLink.step1')}</li>
                <li>{t('canvasLink.step2')}</li>
                <li>{t('canvasLink.step3')}</li>
              </ol>
            </div>

            {info.canvasCourses.length > 0 && (
              <div>
                <p className="mb-1 text-sm font-medium text-gray-800">{t('canvasLink.usedIn')}</p>
                <ul className="list-disc pl-5 text-sm text-gray-700" data-testid="list-canvas-courses">
                  {info.canvasCourses.map((c, i) => <li key={i}>{c.title || t('canvasLink.unnamed')}</li>)}
                </ul>
              </div>
            )}

            {isAdmin && (
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                <p className="mb-1 text-xs font-medium text-gray-700">{t('canvasLink.adminConfig')}</p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate text-xs text-gray-600">{info.configUrl}</code>
                  <button type="button" onClick={() => copy(info.configUrl, 'cfg')} className="whitespace-nowrap rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-100">
                    {copied === 'cfg' ? t('canvasLink.copied') : t('canvasLink.copy')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
