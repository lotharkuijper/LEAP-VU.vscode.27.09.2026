import { useState } from 'react';
import { Mail, KeyRound, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useLanguage } from '../i18n';

// Inloggen zonder wachtwoord voor wie via Canvas in LEAP kwam (server/lti.js,
// POST /api/auth/email-code): e-mailadres → code per e-mail → binnen. De server
// zegt nooit of een adres bekend is; alleen Canvas-accounts krijgen een code.

export function EmailCodeLogin({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const { t } = useLanguage();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/auth/email-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const { error: vErr } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' });
    setBusy(false);
    if (vErr) { setError(t('login.code.wrong')); return; }
    onDone();
  };

  return (
    <div className="space-y-4" data-testid="panel-email-code">
      <p className="text-sm text-gray-700">{t('login.code.intro')}</p>
      {!sent ? (
        <form onSubmit={requestCode} className="space-y-3">
          <label htmlFor="code-email" className="block text-sm font-semibold text-gray-700">{t('login.code.emailLabel')}</label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400" aria-hidden="true" />
            <input
              id="code-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-gray-300 py-3 pl-10 pr-4 outline-none focus:ring-2 focus:ring-blue-500"
              data-testid="input-code-email"
            />
          </div>
          <button type="submit" disabled={busy || !email.trim()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 py-3 font-semibold text-white hover:bg-blue-700 disabled:opacity-50" data-testid="button-code-request">
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : t('login.code.send')}
          </button>
        </form>
      ) : (
        <form onSubmit={verify} className="space-y-3">
          <p className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800" data-testid="text-code-sent">{t('login.code.sent', { email: email.trim() })}</p>
          <label htmlFor="code-input" className="block text-sm font-semibold text-gray-700">{t('login.code.codeLabel')}</label>
          <div className="relative">
            <KeyRound className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400" aria-hidden="true" />
            <input
              id="code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 10))}
              className="w-full rounded-lg border border-gray-300 py-3 pl-10 pr-4 text-lg tracking-[0.3em] outline-none focus:ring-2 focus:ring-blue-500"
              data-testid="input-code"
            />
          </div>
          <button type="submit" disabled={busy || code.length < 6} className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 py-3 font-semibold text-white hover:bg-blue-700 disabled:opacity-50" data-testid="button-code-verify">
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : t('login.code.verify')}
          </button>
          <button type="button" onClick={() => requestCode()} disabled={busy} className="block w-full text-sm text-blue-600 hover:text-blue-700">{t('login.code.resend')}</button>
        </form>
      )}
      {error && <p className="text-sm text-red-700" data-testid="text-code-error">{error}</p>}
      <button type="button" onClick={onCancel} className="block w-full text-sm text-gray-600 hover:text-gray-800" data-testid="button-code-cancel">{t('login.code.back')}</button>
    </div>
  );
}
