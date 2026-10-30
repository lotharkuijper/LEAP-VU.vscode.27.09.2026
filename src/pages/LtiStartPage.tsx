import { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useLanguage } from '../i18n';

// Landingspagina na een klik op de Canvas-link (server/lti/lti.js). De server zet
// in het #-deel een eenmalige inlogcode (token_hash) en de cursus, of een
// foutcode. De code wordt meteen ingewisseld voor een gewone LEAP-sessie en
// daarna uit de adresbalk gehaald.

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];
const KNOWN_ERRORS = new Set([
  'noEmail', 'noRole', 'courseUnknown', 'courseNotCanvas', 'courseInactive', 'expired', 'stateMismatch',
  'invalidToken', 'nonceMismatch', 'unknownPlatform', 'unknownDeployment', 'loginFailed', 'badRequest',
  'accountConflict',
]);

/** Pure: leest het #-deel van de landingspagina. */
export function parseLtiFragment(hash: string): { tokenHash: string | null; course: string | null; error: string | null; next: string | null } {
  const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  // next: alleen een pad binnen de projecten van LEAP (vanuit een Canvas-projectlink).
  const next = p.get('next');
  const safeNext = next && /^\/projects(\/[0-9a-f-]{36}\/group\/[0-9a-f-]{36})?$/i.test(next) ? next : null;
  return { tokenHash: p.get('token_hash'), course: p.get('course'), error: p.get('error'), next: safeNext };
}

export default function LtiStartPage() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const { tokenHash, error: err, next } = parseLtiFragment(window.location.hash);
    // De code nooit in de adresbalk of geschiedenis laten staan.
    window.history.replaceState(null, '', window.location.pathname);
    if (err || !tokenHash) { setError(err && KNOWN_ERRORS.has(err) ? err : 'loginFailed'); return; }
    (async () => {
      const { error: vErr } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
      if (vErr) { setError('loginFailed'); return; }
      navigate(next || '/dashboard', { replace: true });
    })();
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 text-center shadow-lg" data-testid="page-lti-start">
        {!error ? (
          <>
            <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-brand-600" aria-hidden="true" />
            <p className="text-gray-800" data-testid="text-lti-busy">{t('lti.busy')}</p>
          </>
        ) : (
          <>
            <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-amber-600" aria-hidden="true" />
            <h1 className="mb-2 text-lg font-semibold text-gray-900">{t('lti.errorTitle')}</h1>
            <p className="mb-4 text-sm text-gray-700" data-testid="text-lti-error">{t(`lti.error.${error}` as TKey)}</p>
            <Link to="/login" className="text-sm font-medium text-brand-700 hover:underline">{t('lti.toLogin')}</Link>
          </>
        )}
      </div>
    </div>
  );
}
