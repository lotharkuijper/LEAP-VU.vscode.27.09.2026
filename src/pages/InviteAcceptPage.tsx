import { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useLanguage } from '../i18n';

// Landingspagina na een klik op "Account activeren" in de uitnodigingsmail van
// een docent (server/courses/courseInvitations.js). Het #-deel bevat het token; de
// server wisselt het in voor een eenmalige inlogcode. Daarna kiest een nieuwe
// student een wachtwoord (/activate); wie al een wachtwoord heeft, gaat door
// naar het Dashboard. De cursus is al de actieve cursus.

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];
const KNOWN_ERRORS = new Set(['invalid', 'gone', 'used', 'expired', 'tooMany', 'loginFailed']);

/** Pure: haalt het token uit het #-deel. */
export function parseInviteFragment(hash: string): string | null {
  return new URLSearchParams(String(hash || '').replace(/^#/, '')).get('t');
}

export default function InviteAcceptPage() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = parseInviteFragment(window.location.hash);
    // Het token niet in de adresbalk of geschiedenis laten staan.
    window.history.replaceState(null, '', window.location.pathname);
    if (!token) { setError('invalid'); return; }
    (async () => {
      try {
        const res = await fetch('/api/invitations/accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || !d.tokenHash) { setError(KNOWN_ERRORS.has(d.code) ? d.code : 'loginFailed'); return; }
        const { error: vErr } = await supabase.auth.verifyOtp({ token_hash: d.tokenHash, type: d.type === 'invite' ? 'invite' : 'magiclink' });
        if (vErr) { setError('loginFailed'); return; }
        navigate(d.needsPassword ? '/activate' : '/dashboard', { replace: true });
      } catch {
        setError('loginFailed');
      }
    })();
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 text-center shadow-lg" data-testid="page-invite-accept">
        {!error ? (
          <>
            <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-brand-600" aria-hidden="true" />
            <p className="text-gray-800" data-testid="text-invite-busy">{t('invite.busy')}</p>
          </>
        ) : (
          <>
            <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-amber-600" aria-hidden="true" />
            <h1 className="mb-2 text-lg font-semibold text-gray-900">{t('invite.errorTitle')}</h1>
            <p className="mb-4 text-sm text-gray-700" data-testid="text-invite-error">{t(`invite.error.${error}` as TKey)}</p>
            <Link to="/login" className="text-sm font-medium text-brand-700 hover:underline">{t('invite.toLogin')}</Link>
          </>
        )}
      </div>
    </div>
  );
}
