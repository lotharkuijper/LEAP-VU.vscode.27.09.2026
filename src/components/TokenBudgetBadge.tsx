import { useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import { useLanguage } from '../i18n';
import { useAuth } from '../contexts/AuthContext';
import { HelpTip } from './help/HelpTip';

// AI-gebruik in procenten (2026-10-28, server/account/tokenBudget.js). Alleen voor
// accounts uit open registratie; voor alle anderen toont dit niets. Ververst
// bij het openen en daarna elke twee minuten.
interface Budget { applies: boolean; dayPercent?: number; weekPercent?: number; blocked?: 'day' | 'week' | 'global' | null }

export function TokenBudgetBadge({ className = '' }: { className?: string }) {
  const { t } = useLanguage();
  const { session } = useAuth();
  const [b, setB] = useState<Budget | null>(null);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    let stop = false;
    const load = () => fetch('/api/me/token-budget', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null)).then(d => { if (!stop && d) setB(d); }).catch(() => {});
    void load();
    const timer = setInterval(load, 120_000);
    return () => { stop = true; clearInterval(timer); };
  }, [session?.access_token]);

  if (!b?.applies) return null;
  const week = b.weekPercent ?? 0;
  const day = b.dayPercent ?? 0;
  const warn = !!b.blocked || week >= 80 || day >= 80;
  return (
    <span className={`flex flex-nowrap items-center gap-1 ${className}`}>
      <span
        className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 text-xs ${warn ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-gray-200 bg-white text-gray-600'}`}
        data-testid="badge-token-budget"
      >
        <Gauge className="w-3.5 h-3.5" aria-hidden="true" />
        {b.blocked
          ? t(`tokenBudget.blocked.${b.blocked}` as 'tokenBudget.blocked.day')
          : t('tokenBudget.usage', { week: String(week), day: String(day) })}
      </span>
      <HelpTip id="student.tokenBudget" always />
    </span>
  );
}
